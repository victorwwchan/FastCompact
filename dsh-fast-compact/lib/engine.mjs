/**
 * The dsh-fast-compact compaction engine — an official base-compact subclass.
 *
 * Selection, the durable bracket transaction (`compaction/start` →
 * `compaction/summary` → replacement `user/message` → `compaction/end`),
 * pressure policy, token-meter pricing, retention, shrink validation and
 * overflow recovery all stay with `@deepseek-ai/dsh-compaction-basic`: this
 * class does not re-implement any of them. It overrides the one hook the base
 * documents — `summarize(input, agent, signal)` — so the replacement text is
 * compiled deterministically from the session log instead of produced by an LLM
 * request. The base still wraps that text in its checkpoint framing and still
 * rejects a summary that would not shrink the shadowed span.
 *
 * Row config is this plugin's own surface: the base's zod schema is replaced by
 * `null` so cordis does not reject our keys; the row is split in the
 * constructor, host keys are forwarded to the base (which validates them) and
 * ours are validated here. ONE host key is derived instead of forwarded:
 * `headroomTokens`, merged from the per-route table `index.mjs` read off the
 * adapter metadata: the base's own formula wants a margin scaled to each window,
 * and its default assumes a huge one. `thresholdRatio` rides untouched — the row
 * states it as a share of the RAW window, which is the basis the base multiplies
 * and the basis every report prints, so one number both sets and explains the
 * firing point.
 *
 * @module dsh-fast-compact/engine
 */

import path from 'node:path';
import { resolveFastCompactConfig, splitRowConfig, applyDerivedHeadroom, deriveHeadroomTokens, HEADROOM_RATIO } from './config.mjs';
import { buildCheckpoint } from './compiler.mjs';
import { releasePins } from './pins.mjs';

export const ENGINE_PROVIDER = 'dsh-fast-compact';
export const ENGINE_MODEL = 'fast-compact-compiler-v1';
export const LOG_PREFIX = '[fast-compact]';

/** How many sessions keep a runtime shape override / last-compaction record. */
const PER_SESSION_CAP = 64;

/** Build the engine class over the harness classes of the RUNNING dsh install. */
export function createEngineClass(runtime) {
  const Base = runtime.BasicCompactionEngine;

  class FastCompactEngine extends Base {
    static inject = [...Base.inject, 'tokenMeter', 'sessions'];
    /** This plugin owns the row surface; the base schema would reject our keys. */
    static Config = null;

    constructor(ctx, config = {}) {
      const split = splitRowConfig(config);
      // The row carries no absolute headroom — `index.mjs` resolved every route's
      // capacity through ctx.llm and handed those numbers in as `derivedHeadroom`;
      // merging them here is what keeps the base's gate honest per window.
      super(ctx, applyDerivedHeadroom(split.host, split.ours.derivedHeadroom));
      this.options = resolveFastCompactConfig(config);
      // The raw table (capacities + derived pairs) stays readable for reporting:
      // `/fastcompact` and the `debug` stats block state the actual gate each route
      // now fires at, which only these numbers can give them.
      this.pressureTable = split.ours.derivedHeadroom;
      // Per-session runtime state (shape overrides, last compaction record): a
      // bounded insertion-ordered map, so a long-lived process never grows it.
      this.shapeOverrides = new Map();
      this.lastCompactions = new Map();
      // Routes learned AFTER mount, keyed `provider/model`: the mount-time table
      // can miss a route (the capacity service was not ready while the plugin was
      // mounting, or the profile added the route later). The gate must still be
      // enforced, so the first compaction decision for an unknown route reads its
      // capacity through the same `llm` service and derives the pair here — the
      // row's ratio semantics (a share of that route's WINDOW) then govern the
      // guard AND the debug stats, instead of silently falling back to the base.
      this.routeGates = new Map();
      // The row's own ratios, kept so a late-read route can be sized with the
      // number the user actually wrote (per-route entry wins over the row value).
      this.rowRatio = typeof config.thresholdRatio === 'number' ? config.thresholdRatio : null;
      this.rowRatios = new Map();
      if (Array.isArray(config?.modelPolicies)) {
        for (const policy of config.modelPolicies) {
          if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) continue;
          if (typeof policy.thresholdRatio === 'number') this.rowRatios.set(`${policy.provider}/${policy.model}`, policy.thresholdRatio);
        }
      }
      this.headroomRatio = typeof config?.headroomRatio === 'number' ? config.headroomRatio : HEADROOM_RATIO;
    }

    /**
     * The gate one session's route fires at, from the mount table or learned on
     * demand. `describeRoute` reads the table `index.mjs` built at mount; when it
     * names nothing for this route, the capacity is read through `ctx.llm` right
     * now and cached, so a route that was invisible at mount still gets its real
     * window-relative gate instead of riding the base's envelope threshold. W itself
     * comes straight from the session (`requestContext()`), which is what the token
     * meter prices against — no capacity lookup when the route already rode a
     * request. Null only when no window can be named at all (then nothing is
     * invented).
     * @param {object} session - the session whose request header names the route.
     * @returns {object|null} - `{ route, contextWindow, outputReserved, messageBudget, headroomTokens, thresholdRatio, gateTokens, requestedGateTokens, ceilingTokens, clampedToCeiling, beyondBudget }`, with `headroomTokens` null when no margin could be derived (the clamp then uses the bare message budget).
     */
    async learnRoute(session) {
      const known = this.routeFor(session);
      if (known !== null) return known;
      const config = session.requestHeader()?.config;
      if (config === undefined || typeof config.provider !== 'string' || typeof config.model !== 'string') return null;
      const key = `${config.provider}/${config.model}`;
      const ratio = this.rowRatios.get(key) ?? this.rowRatio;
      if (ratio === null) return null; // the row states no ratio: leave the base's decision alone
      // W straight from the session when its route has already ridden a request:
      // `requestContext()` is what dsh-agent-loop appends as `request/context`
      // (dsh-agent-loop/lib/index.js:1262) and the denominator of the meter's own
      // `contextPressure` projection — the window that routed request ACTUALLY got,
      // with no capacity lookup and no re-derivation. The adapter metadata only fills
      // in for a session that has not sent one yet.
      const live = session.requestContext();
      let contextWindow = typeof live?.contextWindow === 'number' ? live.contextWindow : undefined;
      let defaultMaxTokens = 0;
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        const llm = this.ctx?.llm;
        if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null;
        let info;
        try {
          info = await llm.resolveModelInfo(config.provider, config.model);
        } catch (error) {
          this.ctx?.logger?.warn(`${LOG_PREFIX} route ${key} has no readable capacity at compaction time (${String(error.message)}); the base's own gate governs it`);
          return null;
        }
        contextWindow = typeof info === 'object' ? info.context?.contextWindow : undefined;
        defaultMaxTokens = typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : 0;
      }
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) return null;
      const outputReserved = typeof config.maxTokens === 'number' ? config.maxTokens : defaultMaxTokens;
      const messageBudget = contextWindow - outputReserved;
      // The gate is one comparison: the row's share of W, against what the meter
      // says the MESSAGES cost. `deriveHeadroomTokens` derives only the base-side
      // margin this plugin still hands the engine; the requested share, the
      // ceiling, the clamp and the object itself are ALL computed by
      // `buildRouteGate` — the same function `describeRoute` uses for a
      // table-named route, so the table path and the learned path always carry
      // one gate number for one route. A share the messages can never reach
      // clamps to that ceiling — pressure then fires at the last reachable step
      // instead of never firing, and the clamp is reported.
      let headroomTokens = null;
      try {
        headroomTokens = deriveHeadroomTokens(contextWindow, ratio, defaultMaxTokens, this.headroomRatio);
      } catch (error) {
        // The margin feeds only the base's own formula; a rejected derivation
        // leaves the base default in place, and this plugin's gate never needed it.
        this.ctx?.logger?.warn(`${LOG_PREFIX} derived margin for ${key} rejected (${String(error.message)}); the base keeps its own headroom while the row's share still gates`);
      }
      if (!(Math.ceil(contextWindow * ratio) > 0) || !(messageBudget > 0)) return null;
      const gate = buildRouteGate(key, contextWindow, outputReserved, headroomTokens, ratio);
      this.routeGates.set(key, gate);
      while (this.routeGates.size > PER_SESSION_CAP) this.routeGates.delete(this.routeGates.keys().next().value);
      return gate;
    }

    /** Route lookup that prefers anything this instance already learned. */
    routeFor(session) {
      const config = session.requestHeader()?.config;
      if (config === undefined) return null;
      const learned = this.routeGates.get(`${config.provider}/${config.model}`);
      if (learned !== undefined) return learned;
      return describeRoute(this.pressureTable, session);
    }

    /**
     * Automatic compaction, deferred until the row's window percentage says so.
     *
     * The base decides on `tokenMeter.measure(session).totalTokens`, which prices
     * the whole request envelope: the conversation surface PLUS the route's tool
     * schemas (`estimateToolsTokens(header)` in dsh-token-meter/lib/index.js:83,
     * folded into the baseline at line 753). Tool schemas are a per-request
     * constant no conversation can grow, so an envelope-based reading gets a head
     * start that nothing in the session controls — on strata-llm/64KB (W=65,535)
     * with schemas near 19,000 that is ~29% of the window already spent before the
     * first message token counts, and the base re-trips on nearly every later
     * response because the retained tail only has to climb back over a threshold
     * the schemas nearly filled.
     * The row's ratio is a share of the route's WINDOW, so the gate it names is a
     * percentage of the messages; enforce it HERE against `surfaceTokens` — the
     * meter's surface-only reading, which excludes envelope overhead by
     * construction — and against `ceil(W * ratio)` read off the window the session
     * actually rode. Nothing else enters the comparison: no output reservation, no
     * headroom, no budget-relative translation (see deriveRoutePressure). The same
     * number therefore means the same thing in the mount log, in `/fastcompact`
     * and in the checkpoint's stats block. Everything else stays with the base:
     * selection, retention, pruning, the retry loop and the durable compaction
     * bracket.
     *
     * `context-overflow` is never guarded: recovery reacts to a provider-confirmed
     * rejection and must act even when the messages sit under the gate. A route
     * whose capacity neither the mount table nor `learnRoute` can name yields no
     * gate, so nothing is invented and the base's own decision rides untouched —
     * and that route is read through `ctx.llm` at this very moment, so a profile
     * whose capacities were not ready at mount still gets its real window-relative
     * gate on the first pressure decision instead of riding the base's envelope
     * threshold alone.
     * @param {object} agent - agent owning the session the base would measure.
     * @param {'pressure'|'context-overflow'} trigger - the base's two triggers.
     * @param {AbortSignal} signal - cancellation forwarded to summarization.
     * @returns {object|null} - the base's compaction result, or null.
     */
    async compactIfNeeded(agent, trigger, signal) {
      if (trigger === 'pressure') {
        const meter = this.ctx?.tokenMeter;
        const route = await this.learnRoute(agent?.session);
        if (meter !== undefined && typeof meter.measure === 'function' && route !== null) {
          const measurement = meter.measure(agent.session);
          if (measurement.surfaceTokens < route.gateTokens) return null;
        }
		
		
      }
      return await super.compactIfNeeded(agent, trigger, signal);
    }

    /** Resolve the reference-line shape one session will use, override first. */
    resolveShape(session) {
      const override = this.shapeOverrides.get(session?.id) ?? {};
      return {
        refLineFormat: override.refLineFormat ?? this.options.refLineFormat,
        thoughtChars: override.thoughtChars ?? this.options.thoughtChars,
      };
    }

    /**
     * Change the reference-line shape of ONE session from its next compaction on.
     * A `null` value clears that override; the configured preset resumes.
     * @param {object} session - the session to change.
     * @param {{ refLineFormat: string|null, thoughtChars: number|null }} patch
     * @returns {{ refLineFormat: string, thoughtChars: number }} - what it is now.
     */
    setShape(session, patch = {}) {
      const next = { ...(this.shapeOverrides.get(session?.id) ?? {}) };
      for (const key of ['refLineFormat', 'thoughtChars']) {
        if (!(key in patch)) continue;
        const value = patch[key];
        if (value === null || value === undefined) delete next[key];
        else next[key] = value;
      }
      // Reject through the same rules the row config uses, so a bad runtime
      // value fails with the same message as a bad row.
      const resolved = resolveFastCompactConfig({ ...this.options, toolNames: this.options.toolNames, ...next });
      if (Object.keys(next).length === 0) this.shapeOverrides.delete(session.id);
      else {
        this.shapeOverrides.set(session.id, next);
        while (this.shapeOverrides.size > PER_SESSION_CAP) this.shapeOverrides.delete(this.shapeOverrides.keys().next().value);
      }
      return { refLineFormat: resolved.refLineFormat, thoughtChars: resolved.thoughtChars };
    }

    /**
     * Measure what one compaction did to the routed window — the numbers behind
     * the `debug` stats block and `/fastcompact`. They come from the SAME token
     * meter the base gates on (`ctx.tokenMeter.measure`) and the SAME capacity
     * table `index.mjs` read off the adapters, so a checkpoint that says "fired at
     * 46.1% of the window" is reporting the figure that actually tripped, not a
     * re-derived guess. With no capacity known for the route (no capacity service
     * at mount, or a route the table never named) the token counts still come back
     * and the percentages simply are absent — inventing a window would print a
     * percentage that governed nothing.
     * @param {object} session - the session being compacted.
     * @param {{ start: number, end: number }} range - shadowed seq range.
     * @param {string} checkpointText - the compiled body WITHOUT its stats line.
     * @returns {object|null} - null only when no token meter is mounted.
     */
    contextStats(session, range, checkpointText) {
      const meter = this.ctx?.tokenMeter;
      if (meter === undefined || typeof meter.measure !== 'function') return null;
      const measurement = meter.measure(session);
      let shadowedTokens = 0;
      for (const node of measurement.nodes ?? []) {
        if (node.seq >= range.start && node.seq <= range.end) shadowedTokens += node.heuristicTokens;
      }
      const checkpointTokens = typeof meter.estimateMessage === 'function'
        ? meter.estimateMessage({ role: 'user', content: [{ type: 'text', text: checkpointText }] })
        : 0;
      // The row's gate governs the MESSAGES, so the block prices that same basis:
      // `surfaceTokens` is what a request carries minus the per-request tool
      // schemas the meter folds in on its own (`estimateToolsTokens(header)` at
      // dsh-token-meter/lib/index.js:83, added to the baseline at line 753). The
      // envelope total is reported next to it as `envelopeTokens`, so a "why did
      // 0.8 trip at 28% of my window" report is answerable from the checkpoint
      // itself: schemas are a constant the conversation cannot grow.
      const beforeTokens = measurement.surfaceTokens;
      const toolSchemaTokens = Math.max(0, measurement.totalTokens - measurement.surfaceTokens);
      const afterTokens = Math.max(0, beforeTokens - shadowedTokens + checkpointTokens);
      const stats = {
        rangeStart: range.start,
        rangeEnd: range.end,
        beforeTokens,
        surfaceTokens: measurement.surfaceTokens,
        toolSchemaTokens,
        envelopeTokens: measurement.totalTokens,
        shadowedTokens,
        checkpointTokens,
        afterTokens,
        freedTokens: Math.max(0, beforeTokens - afterTokens),
      };
      const capacity = this.routeFor(session);
      if (capacity === null) return stats;
      return { ...stats, ...capacity };
    }

    /**
     * Compile the checkpoint for the span the base selected.
     * @param {object} input - replayed prefix (system head, then region messages).
     * @param {object} agent - the agent owning the session.
     * @param {AbortSignal} signal - cancellation forwarded by the caller.
     * @returns {{ summary: object[], provider: string, model: string }}
     */
    async summarize(input, agent, signal) {
      signal?.throwIfAborted();
      const session = agent.session;
      const range = locateRegion(session, input);
      if (range === null) {
        // The region could not be matched back to the log: fall back to the base
        // behavior so the conversation still compacts instead of failing.
        return await super.summarize(input, agent, signal);
      }
      const shape = this.resolveShape(session);
      const capacity = this.routeFor(session);
      const compileOptions = {
        thoughtChars: shape.thoughtChars,
        refLineFormat: shape.refLineFormat,
        instructions: this.options.instructions,
        // Row-level only: the pinned human-text length and the debug trail /
        // window-accounting block are preset choices, not something one session
        // reshapes mid-run.
        retainLength: this.options.retainLength,
        debug: this.options.debug,
        debugChars: this.options.debugChars,
        toolNames: this.options.toolNames,
        // The size cap and the window it is a share OF: the row names a ratio, the
        // route that will serve the resumed request names the capacity. The share is
        // taken of `messageBudgetTokens` (window − reserved output) when the route can
        // name it — that is the only room the checkpoint and the rest of the history
        // ever travel in — and falls back to the raw window when it cannot.
        contextMaxRatio: this.options.contextMaxRatio,
        contextWindowTokens: capacity?.contextWindow ?? 0,
        messageBudgetTokens: capacity?.messageBudget ?? 0,
      };
      const first = buildCheckpoint(session, range.start, range.end, compileOptions);
      let { text, stats } = first;
      let debugDumpPath = null;
      if (this.options.debug) {
        // Name the dump file BEFORE compiling so the window itself can carry
        // where its on-disk copy lives.
        debugDumpPath = this.debugDumpTarget(session.id, range);
        // The `debug` block cannot price itself: measure the body WITHOUT it, then
        // re-compile once with the accounting folded in. `checkpointTokens` in the
        // block is that pre-stats size — exactly what the block says it excludes —
        // so the printed after-figures reconcile against it line for line.
        const measured = this.contextStats(session, range, text);
        if (measured !== null && typeof measured === 'object') measured.debugDumpPath = debugDumpPath;
        const rebuilt = buildCheckpoint(session, range.start, range.end, { ...compileOptions, contextStats: measured });
        text = rebuilt.text;
        stats = rebuilt.stats;
      }
      // `debug` also leaves a copy of the compiled window on disk — exactly what
      // OUR compiler emitted, before the base wraps it in its own preamble and
      // `<compacted-summary>` frame upstream — so "why did it say that" is
      // answerable after the fact. A write failure must never fail the compaction
      // itself.
      const dumped = this.options.debug ? await this.dumpDebug(session.id, range, text, debugDumpPath) : null;
      // The path that actually made it to disk rides in the record, next to the
      // numbers it documents (a failed write stays out of the record).
      const accounting = stats?.contextStats;
      if (dumped !== null && accounting !== null && typeof accounting === 'object') {
        stats.debugDumpPath = dumped;
        accounting.debugDumpPath = dumped;
      }
      this.recordCompaction(session, { start: range.start, end: range.end, stats });
      // Pins the span carries are now honored by the checkpoint itself: drop
      // them so a later compaction does not repeat the same content.
      releasePins(session, range.seqs);
      return {
        summary: [{ type: 'text', text }],
        provider: ENGINE_PROVIDER,
        model: ENGINE_MODEL,
      };
    }

    /** Remember what the last deterministic compaction of one session did. */
    recordCompaction(session, record) {
      this.lastCompactions.set(session.id, { at: Date.now(), ...record });
      while (this.lastCompactions.size > PER_SESSION_CAP) this.lastCompactions.delete(this.lastCompactions.keys().next().value);
    }

    /**
     * The file the next `debug` dump will land in — resolved BEFORE compilation
     * so the window itself can name it in its stats block. One file per
     * compaction in `debug/` under the process working directory, named from the
     * session id and the shadowed seq range so consecutive compactions of the
     * same session never collide. The row knob `debug` gates it.
     * @param {string} sessionId - owning session id.
     * @param {{ start: number, end: number }} range - shadowed seq range.
     * @returns {string} resolved dump file path.
     */
    debugDumpTarget(sessionId, range) {
      return path.join(path.resolve('debug'), `session-${sessionId}-${Date.now()}-seq${range.start}-${range.end}.txt`);
    }

    /**
     * Leave a copy of the compiled context window on disk (row knob `debug`):
     * writes to the pre-named target, or a freshly named one when none was
     * passed. Returns the resolved file path, or null when there is nothing to
     * write; a failure only warns — the dump is a diagnostic and must never fail
     * the compaction that produced the text.
     * @param {string} sessionId - owning session id.
     * @param {{ start: number, end: number }} range - shadowed seq range.
     * @param {string} text - the FULL compiled checkpoint (stats block included).
     * @param {string|null} [target] - path from `debugDumpTarget`, when named up front.
     * @returns {Promise<string|null>}
     */
    async dumpDebug(sessionId, range, text, target = null) {
      if (text === undefined || text === null || text === '') return null;
      const fs = await import('node:fs/promises');
      try {
        const file = target ?? this.debugDumpTarget(sessionId, range);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, text, 'utf8');
        this.ctx?.logger?.info(`${LOG_PREFIX} debug: context window of session ${String(sessionId)} (seq ${range.start}–${range.end}) dumped to ${file}`);
        return file;
      } catch (error) {
        this.ctx?.logger?.warn(`${LOG_PREFIX} debug: could not dump the context window of session ${String(sessionId)} (${String(error.message)})`);
        return null;
      }
    }

    /** The last deterministic compaction of one session, for `/fastcompact`. */
    lastCompaction(session) {
      return this.lastCompactions.get(session?.id);
    }

    /** The reference-line shape one session will use, for `/fastcompact`. */
    currentShape(session) {
      return this.resolveShape(session);
    }

    /**
     * Live window accounting for `/fastcompact`: the gate this route now fires at
     * and what its messages cost right now, before any compaction. Raw numbers —
     * the command formats them. Null when no token meter is mounted; a route whose
     * capacity table has no entry reports only `currentTokens`. The gate governs
     * the MESSAGE surface, so `currentTokens` is that surface; the envelope total
     * (which also carries the route's tool schemas) rides as `envelopeTokens`.
     * @param {object} session - the session to price.
     * @returns {object|null}
     */
    pressureReport(session) {
      const meter = this.ctx?.tokenMeter;
      if (meter === undefined || typeof meter.measure !== 'function') return null;
      const measurement = meter.measure(session);
      const surfaceTokens = typeof measurement.surfaceTokens === 'number' ? measurement.surfaceTokens : measurement.totalTokens;
      const toolSchemaTokens = Math.max(0, measurement.totalTokens - surfaceTokens);
      const fields = {
        currentTokens: surfaceTokens,
        envelopeTokens: measurement.totalTokens,
        toolSchemaTokens,
      };
      const capacity = this.routeFor(session);
      if (capacity === null) return { route: null, ...fields };
      return { ...capacity, ...fields };
      }

      /**
       * Where the row knob `debug` leaves its dumps, for `/fastcompact`: whether
       * the knob is on, the resolved `debug/` directory under the process working
       * directory (recomputed each call — it follows the CWD of the running dsh
       * process, which is what "no dump file found" questions are usually about),
       * and the file the last compaction of THIS session actually wrote, when the
       * accounting recorded one.
       * @param {object} session - the session whose last dump to name.
       * @returns {{ enabled: boolean, dir: string, lastDump: string|null }}
       */
      debugStatus(session) {
        const stats = this.lastCompaction(session)?.stats;
        return {
          enabled: Boolean(this.options.debug),
          dir: path.resolve('debug'),
          lastDump: typeof stats?.debugDumpPath === 'string' ? stats.debugDumpPath : null,
        };
      }

      /**
       * The row's own configuration knobs for `/fastcompact`, as they resolve for
       * ONE session's route: the base-resolved row (this.config) already carries
       * `thresholdRatio` and the retention choice with the base's defaults applied,
       * so per-route `modelPolicies` overrides are the only thing this method adds
       * — plus this plugin's own `contextMaxRatio`, which never crosses into the
       * base. Raw numbers; the command formats them.
       * @param {object} session - the session whose route governs the numbers.
       * @returns {{ thresholdRatio: number|null, retainRatio: number|null, retainTokens: number|null, contextMaxRatio: number }}
       */
      configStatus(session) {
        const header = session?.requestHeader()?.config;
        const row = this.config ?? {};
        const override = Array.isArray(row.modelPolicies) && header !== undefined
          ? row.modelPolicies.find((policy) => policy.provider === header.provider && policy.model === header.model) ?? null
          : null;
        const gate = this.routeFor(session);
        const thresholdRatio = gate?.thresholdRatio ?? override?.thresholdRatio ?? row.thresholdRatio ?? BASE_DEFAULT_THRESHOLD_RATIO;
        let retainRatio = null;
        let retainTokens = null;
        if (override !== null && override.retainTokens !== undefined) {
          retainTokens = override.retainTokens;
        } else if (override !== null && override.retainRatio !== undefined) {
          retainRatio = override.retainRatio;
        } else if (row.retainTokens !== undefined) {
          retainTokens = row.retainTokens;
        } else {
          retainRatio = row.retainRatio ?? null;
        }
        return { thresholdRatio, retainRatio, retainTokens, contextMaxRatio: this.options.contextMaxRatio };
      }
    }

  return FastCompactEngine;
}

/**
 * Recover the inclusive seq range the base selected for this summarize call.
 * The prefix replays the shadowed region's messages in surface order, and each
 * derived message is the very object stored in the log, so identity locates the
 * span exactly — first and last match, in surface order.
 * @param {object} session - session whose surface carries the region.
 * @param {{ messages: object[] }} input - replayed prefix (optional system head).
 * @returns {{ start: number, end: number, seqs: number[] } | null}
 */
export function locateRegion(session, input) {
  const nodes = session.surface.nodes;
  if (nodes === undefined || nodes.length === 0) return null;
  const messages = Array.isArray(input.messages) ? input.messages : [];
  let region = messages;
  try {
    const head = session.eventAt(nodes[0]);
    if (head !== undefined && head.type === 'system/message') region = messages.slice(1);
  } catch {
    return null;
  }
  if (region.length === 0) return null;
  const wanted = new Set(region);
  let firstIdx;
  let lastIdx = -1;
  for (let index = 0; index < nodes.length; index += 1) {
    const event = session.eventAt(nodes[index]);
    if (event === undefined || event === null) continue;
    const derived = session.deriveEventMessage(event);
    if (derived === null || !wanted.has(derived)) continue;
    if (firstIdx === undefined) firstIdx = index;
    lastIdx = index;
  }
  if (firstIdx === undefined) return null;
  const seqs = nodes.slice(firstIdx, lastIdx + 1);
  return { start: seqs[0], end: seqs[seqs.length - 1], seqs };
}

/** The base's documented default ratio, used ONLY to report what governs a route
 * when the row names none (never to decide anything — the base does). */
const BASE_DEFAULT_THRESHOLD_RATIO = 0.8;

/**
 * The ONE computation of a route's pressure-gate object. Every caller resolves
 * its own inputs — `describeRoute` from the mount table, `learnRoute` from the
 * session plus a live capacity read — and passes them here, so the table path
 * and the learned path always return the same shape with the same numbers for
 * the same route: the row's share of W requested (`ceil(W * ratio)`), the
 * ceiling the messages can actually reach (the bare message budget when no
 * margin could be derived), and the gate clamped to that ceiling so a
 * past-budget share still fires at its last reachable step instead of never
 * firing. Nothing else in this file builds the object.
 * @param {string} route - `provider/model`.
 * @param {number} contextWindow - W, the window the session rode.
 * @param {number} outputReserved - O, this request's reply reservation.
 * @param {number|null} headroomTokens - the derived margin, null when none could be.
 * @param {number} ratio - the row's thresholdRatio (a share of W).
 * @returns {{ route, contextWindow, outputReserved, messageBudget, headroomTokens, thresholdRatio, gateTokens, requestedGateTokens, ceilingTokens, clampedToCeiling, beyondBudget }}
 */
function buildRouteGate(route, contextWindow, outputReserved, headroomTokens, ratio) {
  const requestedGateTokens = Math.ceil(contextWindow * ratio);
  const messageBudget = contextWindow - outputReserved;
  const ceilingTokens = headroomTokens === null ? messageBudget : messageBudget - headroomTokens;
  const gateTokens = Math.min(requestedGateTokens, Math.max(1, ceilingTokens));
  return {
    route,
    contextWindow,
    outputReserved,
    messageBudget,
    headroomTokens,
    thresholdRatio: ratio,
    gateTokens,
    requestedGateTokens,
    ceilingTokens,
    clampedToCeiling: gateTokens < requestedGateTokens,
    // Facts about the row's share against this route's message budget: past it,
    // pressure runs on borrowed time (the clamp above is what keeps it firing at all).
    beyondBudget: requestedGateTokens > messageBudget,
  };
}

/**
 * Resolve the capacity facts of the route one session durably routed, straight
 * from the derived pressure table: W and O as the adapter declared them, plus
 * the headroom and ratio this plugin handed the base for that route — and then
 * `buildRouteGate` derives the gate, exactly as `learnRoute` does for a route
 * the table never named, so both paths carry one number. A route the table
 * never named (or no table at all) yields null: token counts without invented
 * percentages.
 * @param {object|null} table - `derivedHeadroom` as the row config carried it.
 * @param {object} session - the session whose request header names the route.
 * @returns {{ route, contextWindow, outputReserved, messageBudget, headroomTokens, thresholdRatio, gateTokens, requestedGateTokens, ceilingTokens, clampedToCeiling, beyondBudget } | null}
 */
function describeRoute(table, session) {
  const config = session.requestHeader()?.config;
  if (config === undefined || table?.perRoute === undefined) return null;
  const entry = table.perRoute.find((candidate) => candidate.provider === config.provider && candidate.model === config.model);
  if (entry === undefined) return null;
  const contextWindow = entry.contextWindow;
  const outputReserved = config.maxTokens ?? entry.defaultMaxTokens ?? 0;
  const headroomTokens = entry.headroomTokens;
  const messageBudget = contextWindow - outputReserved;
  if (!(typeof contextWindow === 'number' && contextWindow > 0) || !(messageBudget > 0) || !(headroomTokens >= 1)) return null;
  const ratio = typeof entry.thresholdRatio === 'number' ? entry.thresholdRatio : BASE_DEFAULT_THRESHOLD_RATIO;
  if (!(Math.ceil(contextWindow * ratio) > 0)) return null;
  return buildRouteGate(`${config.provider}/${config.model}`, contextWindow, outputReserved, headroomTokens, ratio);
}
