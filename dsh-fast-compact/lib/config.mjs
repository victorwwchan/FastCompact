/**
 * dsh-fast-compact — the row configuration this plugin owns.
 *
 * A compaction row in a preset carries one flat config object. Two halves of it
 * belong to two owners:
 *
 *  - the pressure/retention half belongs to the official DSH base-compact
 *    package (`thresholdRatio`, `retainRatio` / `retainTokens`, `maxTokens`,
 *    `compactionRetries`, `maxOverflowRetries`, `auto`, `modelPolicies`). Those
 *    keys are forwarded to the base class untouched and validated there, so
 *    this plugin never re-decides when to compact. ONE key of that half is NOT
 *    a row key any more: `headroomTokens` is derived per route from that route's
 *    own context window (see deriveRoutePressure / applyDerivedHeadroom) and a
 *    row that still carries it fails at mount;
 *  - the content half belongs to this plugin: what the deterministic checkpoint
 *    is made of and how long its quoted texts run (`thoughtChars` for model
 *    reasoning, `retainLength` for human text).
 *
 * @module dsh-fast-compact/lib/config
 */

/**
 * Base-package keys the row may name. All ride to the official engine untouched —
 * including `thresholdRatio`, which this plugin reads per route but never rewrites
 * (see deriveRoutePressure): the row's share means the same thing on both sides, and
 * the window it applies to is the one the routed request actually gets.
 */
export const HOST_COMPACT_KEYS = Object.freeze([
  'thresholdRatio', 'retainRatio', 'retainTokens',
  'maxTokens', 'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
]);
/**
 * NOTE — `thresholdRatio` is the one host key this plugin reads per route, and it
 * reads it in the base's OWN basis: a share of the route's RAW context window.
 * That is the number the user means when they ask "compact at 80% of my context",
 * and it is the percentage every report prints (the debug stats state usage as a
 * share of the window), so one row number both sets and explains the firing point.
 * The plugin's gate is then one comparison — `surfaceTokens >= ceil(W * ratio)`,
 * with `surfaceTokens` read straight from the token meter (messages only; its
 * envelope total also carries the route's tool schemas, which are a per-request
 * constant no conversation can grow). Nothing else is calculated for the gate: no
 * output reservation, no headroom, no budget-relative translation. What the row
 * still needs per route is the BASE's own margin (its formula wants a headroom
 * scaled to that window, and its default assumes a huge one) plus the facts this
 * plugin reports about where the base lands — see deriveRoutePressure.
 */

/** Keys this plugin owns (everything else in the row is a typo and fails). */
export const FASTCOMPACT_KEYS = Object.freeze(['thoughtChars', 'retainLength', 'refLineFormat', 'instructions', 'debug', 'debugChars', 'toolNames', 'derivedHeadroom', 'contextMaxRatio', 'pluginInstructionInject']);

/**
 * Row knob `contextMaxRatio`: the share of the MESSAGE BUDGET a route leaves its
 * window that the compiled checkpoint may occupy. It bounds what one compaction ADDS
 * to the window — a session that keeps compacting must not keep growing its own
 * summaries — so instead of naming an absolute length per route, the row names a ratio
 * and the compiler multiplies it by the room the RESUMED request actually gets:
 * `messageBudgetTokens` = window − reserved output (when the route names no budget, the
 * raw window stands in — nothing is invented). A 0.25 row on strata-llm/64K (W=65,535,
 * O=32,000 → 33,535-token budget) caps the body at ~8,383 tokens = 33,532 bytes, i.e.
 * 25% of what that route can carry; sizing on the RAW window instead would have allowed
 * 16,383 tokens = 49% of the budget, enough for one compaction to push the session past
 * its own gate. Only the reference section shrinks when the body would pass that cap: it
 * ages its OLDEST units into one range line, so history is coarsened rather than dropped.
 */
export const DEFAULT_CONTEXT_MAX_RATIO = 0.25;

/**
 * ONE length knob for everything human-typed that survives a compaction: each
 * pinned user message line and the state block's "last user request" quote are
 * clipped to this many characters. It joins `thoughtChars` (which caps only
 * model reasoning: the last-thought quote and every reference line's excerpt)
 * rather than adding a second human-text knob per block, so the row reads as two
 * lengths total — one for what the model said, one for what the human said.
 */
export const DEFAULT_RETAIN_LENGTH = 200;

/**
 * The base needs `headroomTokens` as an absolute token count, but that count is
 * meaningless without the route's window: a fixed value sized for one model
 * collapses or explodes the gate on another (see README "Sizing the pressure
 * keys"). So the row does not carry it — `index.mjs` reads each route's capacity
 * through `ctx.llm.resolveModelInfo` and hands the numbers to the engine as this
 * plugin-owned key, which `applyDerivedHeadroom` merges into the host config.
 */
export const DERIVED_HEADROOM_KEY = 'derivedHeadroom';
/** The one row knob of the derivation: headroom as a share of the route's window. */
export const HEADROOM_RATIO = 0.04;
/** Never reserve less than this, unless the route's own budget is smaller. */
export const HEADROOM_MIN_TOKENS = 1_024;
/** Never eat more than this share of the route's message budget (W - O). */
export const HEADROOM_MAX_BUDGET_SHARE = 0.25;
/** Used only when no route capacity could be read at mount. */
export const HEADROOM_FALLBACK_TOKENS = 4_096;

export const DEFAULT_THOUGHT_CHARS = 200;
/** Debug trail (row knob `debug`): replay the range's failed tool calls, off by
 * default so the zero-cost default keeps paying nothing for them. */
export const DEFAULT_DEBUG = false;
/** Characters of error text kept per debug-trail entry (0 = seqs only). */
export const DEFAULT_DEBUG_CHARS = 200;
/** Byte cap on one verbatim user instruction inside the pinned block. */
export const PINNED_MESSAGE_BYTES = 8_000;
/** Byte cap for the whole pinned block (instructions, constraints, files). */
export const PINNED_BLOCK_BYTES = 24_000;
/** Byte cap on the reference section; oldest lines drop first. */
export const REFERENCES_BLOCK_BYTES = 16_000;

export const REF_LINE_FORMATS = Object.freeze(['thought', 'none']);

/**
 * Row knob `pluginInstructionInject`: how often the mount re-injects the plugin's
 * OWN instruction (the `<system-reminder>` ruleset that rides as a user-role copy
 * at `agent/pre-step`). The old behavior — `'step'`, one copy before EVERY step —
 * duplicated the same text dozens of times across a session: each copy costs its
 * own window share and the checkpoint's stats read inflated because of it. The
 * default `'once'` keeps the position rule (the copy still sits at the live end)
 * while spending it ONCE per surface generation: the copy stays live until a
 * compaction replaces the surface, and only that replacement re-arms the mount —
 * so one session carries one instruction copy per compaction cycle instead of one
 * per step. `'pressure'` is stricter still: it arms only when the route's own
 * pressure gate says compaction is due (the same `surfaceTokens >= gateTokens`
 * comparison `compactIfNeeded` makes), which matches "inject only when we are about
 * to compact"; it keeps the per-generation guard so an above-gate session that the
 * base has not compacted yet cannot stack copies. A route whose capacity nobody can
 * name leaves `'pressure'` to the `'once'` rule — inventing a gate would arm at a
 * point nothing governs.
 */
export const PLUGIN_INSTRUCTION_INJECT_MODES = Object.freeze(['once', 'pressure', 'step']);
/** One live copy per surface generation; a compaction re-arms the mount. */
export const DEFAULT_PLUGIN_INSTRUCTION_INJECT = 'once';

/**
 * The row configuration this plugin owns, as one class: every rule that reads or
 * rewrites a preset row is a static method of `Config`, so the call sites name the
 * owner (`Config.splitRowConfig(row)`) instead of a bare module-level function. The
 * key lists and defaults above stay module-level exports — they are plain data, and
 * the mount/preset tooling reads them by those names.
 */
export class Config {
  /**
   * Split one row config into the plugin half and the host half, rejecting keys
   * neither side owns so a stale or misspelled row fails at mount. `headroomTokens`
   * is rejected on its own — in the row or inside one `modelPolicies` entry — because
   * this plugin now derives it from each route's context window.
   * @param {object} row - raw cordis row config.
   */
  static splitRowConfig(row) {
    const ours = {};
    const host = {};
    for (const [key, value] of Object.entries(row ?? {})) {
      if (key === 'headroomTokens') {
        throw new Error('dsh-fast-compact config: headroomTokens is not a row key any more; the plugin derives it per route from that route\'s contextWindow (knob: headroomRatio) — remove it from the row');
      }
      if (FASTCOMPACT_KEYS.includes(key)) ours[key] = value;
      else if (HOST_COMPACT_KEYS.includes(key)) host[key] = value;
      else throw new Error(`dsh-fast-compact config: unknown key "${key}" (plugin keys: ${FASTCOMPACT_KEYS.join(', ')}; host keys: ${HOST_COMPACT_KEYS.join(', ')})`);
    }
    if (Array.isArray(host.modelPolicies)) {
      for (const [index, policy] of host.modelPolicies.entries()) {
        if (policy !== null && typeof policy === 'object' && 'headroomTokens' in policy) {
          throw new Error(`dsh-fast-compact config: modelPolicies[${index}].headroomTokens is not a row key any more; the plugin derives headroom per route from that route's contextWindow — remove it from that policy`);
        }
      }
    }
    return { ours, host };
  }

  /**
   * Derive the pressure facts of one exact route from that route's own capacity.
   *
   * W = the route's adapter `contextWindow`, O = its adapter output default, and
   * U = W - O the message budget a routed request can carry. The row's `thresholdRatio`
   * is a share of W — the SAME basis every report prints (the debug stats state usage
   * as a share of the window) — so the gate this plugin enforces is one number:
   *
   *   gate = min(ceil(W * thresholdRatio), ceiling)                (tokens of MESSAGES)
   *
   * Nothing but the route's own reachability touches it (one clamp to the ceiling, below). No output reservation, no headroom, no budget-relative no headroom, no budget-relative
   * translation: `FastCompactEngine.compactIfNeeded` compares that gate against
   * `measurement.surfaceTokens` from the token meter — the messages alone, with the
   * route's tool schemas excluded by construction — so "compact at 80% of my window"
   * means exactly that, and a small-window route is not quietly gated earlier because
   * its schemas or its reply reservation got folded into the arithmetic.
   *
   * The headroom is still derived, but only for what we hand the BASE (its own formula
   * needs a sane margin, and its default assumes a huge window); it never moves the
   * gate above. What this function reports about the base is facts, not policy:
   *
   *   B              = min(share, budgetCap)                        (clamped to >= 1)
   *   ceiling        = U - B                                        (the base's other term)
   *   gate         = min(ceil(W * thresholdRatio), max(1, ceiling)) (clamped per route)
   *   beyondBudget   = ceil(W * thresholdRatio) > U                                     (past the message budget)
    *   clamped        = gate < ceil(W * thresholdRatio)              (share got clamped)
   *   outputCap      = min(O, max(1024, W - gate))                   (the summary's own cap)
   *
   * `clamped` is what a share that high now means: the messages cannot hold ceil(W x
   * share) tokens once the reply is reserved, so the gate lands at the LAST reachable
   * step (the ceiling), instead of a gate that never fires at all: compaction still
   * happens before the request overflows. The mount line and the stats block both name the
   * share it wanted and the ceiling it had to use instead; `beyondBudget` adds that the share sits past U at all, so pressure here runs on borrowed time rather than on your own share.
   *
   * `outputCapTokens` is why the row no longer needs a hand-written `maxTokens`: the
   * summary's output reservation follows the SAME share — what the gate leaves free of
   * W is (W - gate), so the compaction request never asks for more than that (and never
   * more than the adapter's own default). A row that still names `maxTokens` wins over
   * this; leaving it out is what aligns it.
   *
   * @param {number} contextWindow - positive adapter capacity for one exact route.
   * @param {number|null} thresholdRatio - share of the route's RAW context window
   *   (the basis every report prints), or null when the row names none (then only the
   *   margin is derived and no ratio or gate is returned, so the row's own value rides
   *   untouched and the base governs its own decision).
   * @param {number} defaultMaxTokens - adapter output default (0 when unknown).
   * @param {number} headroomRatio - share of W to reserve for the base (row knob).
   * @returns {{ headroomTokens: number, thresholdRatio: number | null, gateTokens: number | null, ceilingTokens: number, requestedGateTokens: number | null, clampedToCeiling: boolean, beyondBudget: boolean, outputCapTokens: number | null }}
   */
  static deriveRoutePressure(contextWindow, thresholdRatio = null, defaultMaxTokens = 0, headroomRatio = HEADROOM_RATIO) {
    if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
      throw new Error(`dsh-fast-compact config: derived pressure needs a positive integer contextWindow (got ${String(contextWindow)})`);
    }
    if (thresholdRatio !== null && !(typeof thresholdRatio === 'number' && thresholdRatio > 0 && thresholdRatio <= 1)) {
      throw new Error(`dsh-fast-compact config: derived pressure needs thresholdRatio in (0, 1] (got ${String(thresholdRatio)})`);
    }
    if (!Number.isInteger(defaultMaxTokens) || defaultMaxTokens < 0) {
      throw new Error(`dsh-fast-compact config: derived pressure needs a non-negative integer output default (got ${String(defaultMaxTokens)})`);
    }
    if (!(typeof headroomRatio === 'number' && headroomRatio > 0 && headroomRatio < 1)) {
      throw new Error(`dsh-fast-compact config: headroomRatio (${String(headroomRatio)}) must be a number in (0, 1)`);
    }

    const budget = contextWindow - defaultMaxTokens;
    if (budget <= 0) {
      // The route reserves its whole window for output: the base reports this itself
      // ("... leaving no message budget"), keep the margin minimal and name no ratio.
      return { headroomTokens: 1, thresholdRatio: null, gateTokens: null, requestedGateTokens: null, ceilingTokens: 0, clampedToCeiling: false, beyondBudget: false, outputCapTokens: null };
    }
    const share = Math.max(HEADROOM_MIN_TOKENS, Math.round(contextWindow * headroomRatio));
    const budgetCap = Math.max(1, Math.floor(budget * HEADROOM_MAX_BUDGET_SHARE));
    let headroom = Math.min(share, budgetCap);
    // No ratio named for this route: only the margin applies, and the row's own
    // value (absent, so the base default governs) rides untouched.
    if (thresholdRatio === null) {
      return {
        headroomTokens: Math.max(1, headroom),
        thresholdRatio: null,
        gateTokens: null,
        requestedGateTokens: null,
        ceilingTokens: Math.max(0, budget - headroom),
        clampedToCeiling: false,
        beyondBudget: false,
        // With no share named there is no gate to align the summary cap to: the base's
        // own output reservation governs, untouched.
        outputCapTokens: null,
      };
    }

    // The gate is the row's share of W, and that is all: the meter prices the MESSAGES
    // against it, so neither the output reservation nor the headroom enters the decision.
    // `ceil` so a session sitting exactly at that share is already ON the gate; the
    // ceiling only says how high messages can ever climb once the reply is reserved.
    const requestedGateTokens = Math.ceil(contextWindow * thresholdRatio);
    const ceilingTokens = budget - headroom;
    // A share the messages can physically never reach stops being a never-firing gate:
    // it clamps to the last reachable step, so compaction still happens before the
    // request overflows (the clamp is reported, and the row's share is untouched).
    const gateTokens = Math.min(requestedGateTokens, Math.max(1, ceilingTokens));
    // The summary's output cap follows the EFFECTIVE gate: what the gate leaves free of W
    // is (W - gate), so the compaction request never asks for more than that, and never
    // more than what the adapter itself declared. A row that names `maxTokens` still wins —
    // this is only what fills its place when the row leaves the knob out.
    const gateLeavesFree = Math.max(HEADROOM_MIN_TOKENS, contextWindow - gateTokens);
    return {
      headroomTokens: headroom,
      thresholdRatio,
      gateTokens,
      requestedGateTokens,
      ceilingTokens,
      clampedToCeiling: gateTokens < requestedGateTokens,
      beyondBudget: requestedGateTokens > budget,
      outputCapTokens: defaultMaxTokens > 0 ? Math.min(defaultMaxTokens, gateLeavesFree) : gateLeavesFree,
    };
  }

  /** The headroom half of deriveRoutePressure (kept as the tested standalone name). */
  static deriveHeadroomTokens(contextWindow, thresholdRatio = null, defaultMaxTokens = 0, headroomRatio = HEADROOM_RATIO) {
    return Config.deriveRoutePressure(contextWindow, thresholdRatio, defaultMaxTokens, headroomRatio).headroomTokens;
  }

  /**
   * Merge one derived-pressure table into the host half of the row before it rides
   * to the base: every route whose capacity was read gets its own absolute headroom
   * AND its own window-relative ratio (folding into an existing `modelPolicies`
   * entry, keeping that entry's other keys, and appending routes the row never
   * named); routes with no entry inherit `topLevel` / `topLevelThresholdRatio`,
   * which are derived from the smallest window we could read so an unlisted route
   * still gets a sane margin. A missing table falls back to the documented
   * constant — never to the base default, which assumes a huge window.
   * @param {object} host - host half of the row (never mutated).
   * @param {{ topLevel: number, topLevelThresholdRatio: number|null, topLevelOutputCap: number|null, perRoute: object[] }} derived - table from `index.mjs`; each `perRoute` entry may carry `outputCapTokens`, which lands as that policy's `maxTokens`. A row (or policy) that hand-set `maxTokens` keeps its own value — the aligned cap only fills the place where the knob was left out.
   */
  static applyDerivedHeadroom(host, derived) {
    const policies = Array.isArray(host.modelPolicies)
      ? host.modelPolicies.filter((policy) => policy !== null && typeof policy === 'object')
      : [];
    if (derived === undefined || derived === null) {
      return { ...host, headroomTokens: HEADROOM_FALLBACK_TOKENS, modelPolicies: policies.map((policy) => ({ ...policy })) };
    }
    if (typeof derived !== 'object' || Array.isArray(derived)) {
      throw new Error('dsh-fast-compact config: derivedHeadroom must be an object { topLevel, perRoute }');
    }
    const topLevel = derived.topLevel ?? HEADROOM_FALLBACK_TOKENS;
    if (!Number.isInteger(topLevel) || topLevel < 1) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.topLevel (${String(derived.topLevel)}) must be an integer >= 1`);
    }
    // Does the row itself own the summary cap? Then nothing derived touches it, at any
    // level: a hand-written maxTokens is the user's decision, top-level or per-policy.
    const rowOwnsCap = Number.isInteger(host.maxTokens) && host.maxTokens >= 1;
    const perRoute = new Map();
    for (const [index, entry] of (derived.perRoute ?? []).entries()) {
      if (typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}] must be an object`);
      }
      const { provider, model } = entry;
      if (!Config.derivedRouteKey(provider, model) || !Number.isInteger(entry.headroomTokens) || entry.headroomTokens < 1) {
        throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}] needs string provider/model and an integer headroomTokens >= 1`);
      }
      if ('thresholdRatio' in entry && (typeof entry.thresholdRatio !== 'number' || !(entry.thresholdRatio > 0 && entry.thresholdRatio <= 1))) {
        throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}].thresholdRatio must be a number in (0, 1]`);
      }
      if ('outputCapTokens' in entry && (!Number.isInteger(entry.outputCapTokens) || entry.outputCapTokens < 1)) {
        throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}].outputCapTokens must be an integer >= 1`);
      }
      // Only keys the base's modelPolicies schema admits — capacity facts the entry
      // may also carry stay out of the row and live on the engine for reporting.
      const policy = { provider, model, headroomTokens: entry.headroomTokens };
      if ('thresholdRatio' in entry) policy.thresholdRatio = entry.thresholdRatio;
      if (!rowOwnsCap && 'outputCapTokens' in entry) policy.maxTokens = entry.outputCapTokens;
      perRoute.set(`${provider}/${model}`, policy);
    }
    // The default ratio for routes the table never named: the row's own share, sized
    // against the tightest window we read (index.mjs), so an unlisted route still
    // gates at its own share of W rather than inheriting a margin computed for a
    // bigger route. The basis is the window's, so nothing here is re-expressed.
    const topLevelRatio = derived.topLevelThresholdRatio;
    if (topLevelRatio !== undefined && topLevelRatio !== null && !(typeof topLevelRatio === 'number' && topLevelRatio > 0 && topLevelRatio <= 1)) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.topLevelThresholdRatio (${String(topLevelRatio)}) must be a number in (0, 1]`);
    }
    // The summary cap for routes the table never named, sized from the same share at
    // the tightest window we read (index.mjs). A row that hand-set maxTokens still wins.
    const topLevelOutputCap = derived.topLevelOutputCap;
    if (topLevelOutputCap !== undefined && topLevelOutputCap !== null && (!Number.isInteger(topLevelOutputCap) || topLevelOutputCap < 1)) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.topLevelOutputCap (${String(topLevelOutputCap)}) must be an integer >= 1`);
    }
    const merged = policies.map((policy) => {
      const own = perRoute.get(`${policy.provider ?? ''}/${policy.model ?? ''}`);
      const next = { ...policy, headroomTokens: own?.headroomTokens ?? topLevel };
      if (own?.thresholdRatio !== undefined || topLevelRatio !== undefined) {
        next.thresholdRatio = own?.thresholdRatio ?? policy.thresholdRatio ?? topLevelRatio;
      }
      const derivedCap = own?.maxTokens ?? topLevelOutputCap;
      if (!rowOwnsCap && derivedCap !== undefined && next.maxTokens === undefined) next.maxTokens = derivedCap;
      return next;
    });
    const seen = new Set(policies.map((policy) => `${policy.provider ?? ''}/${policy.model ?? ''}`));
    for (const [key, entry] of perRoute) {
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(entry);
    }
    const hostOut = { ...host, headroomTokens: topLevel, modelPolicies: merged };
    // The top-level ratio only lands when the table could translate it; with no
    // capacity service at all the row's own value rides to the base untouched.
    if (topLevelRatio !== undefined && topLevelRatio !== null) hostOut.thresholdRatio = topLevelRatio;
    // Same for the summary cap: only a row that left maxTokens out gets the aligned one.
    if (host.maxTokens === undefined && topLevelOutputCap !== undefined && topLevelOutputCap !== null) hostOut.maxTokens = topLevelOutputCap;
    return hostOut;
  }

    /** Route key used by both halves of the merge (empty parts never match). */
    static derivedRouteKey(provider, model) {
      return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '';
    }

    /** Resolve the plugin half of the row against its defaults. */
    static resolveFastCompactConfig(row) {
      const { ours } = Config.splitRowConfig(row);

    const thoughtChars = ours.thoughtChars ?? DEFAULT_THOUGHT_CHARS;
    if (!Number.isInteger(thoughtChars) || thoughtChars < 0) {
      throw new Error(`dsh-fast-compact config: thoughtChars (${String(ours.thoughtChars)}) must be an integer >= 0`);
    }

    const refLineFormat = ours.refLineFormat ?? 'thought';
    if (!REF_LINE_FORMATS.includes(refLineFormat)) {
      throw new Error(`dsh-fast-compact config: refLineFormat must be one of ${REF_LINE_FORMATS.join(', ')} (got ${JSON.stringify(ours.refLineFormat)})`);
    }

    // One length for human text: pinned user messages and the state block's quote.
    const retainLength = ours.retainLength ?? DEFAULT_RETAIN_LENGTH;
    if (!Number.isInteger(retainLength) || retainLength < 1) {
      throw new Error(`dsh-fast-compact config: retainLength (${String(ours.retainLength)}) must be an integer >= 1 (a pinned user message always keeps some of its words)`);
    }

    const instructions = ours.instructions;
    if (instructions !== undefined && instructions !== null && typeof instructions !== 'string') {
      throw new Error('dsh-fast-compact config: instructions must be a string ("" disables the block)');
    }

    const debug = ours.debug ?? DEFAULT_DEBUG;
    if (debug !== true && debug !== false) {
      throw new Error(`dsh-fast-compact config: debug must be a boolean (got ${JSON.stringify(ours.debug)})`);
    }

    const debugChars = ours.debugChars ?? DEFAULT_DEBUG_CHARS;
    if (!Number.isInteger(debugChars) || debugChars < 0) {
      throw new Error(`dsh-fast-compact config: debugChars (${String(ours.debugChars)}) must be an integer >= 0`);
    }

    // The recall tool names this package registered, so every name the checkpoint
    // prints — reference header, fold line, built-in instruction — matches what this
    // row actually calls (the compiler falls back to `recall` / `recall_search`).
    const toolNames = ours.toolNames ?? {};
    if (typeof toolNames !== 'object' || Array.isArray(toolNames)) {
      throw new Error('dsh-fast-compact config: toolNames must be an object of tool names');
    }
    for (const [key, value] of Object.entries(toolNames)) {
      if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) {
        throw new Error(`dsh-fast-compact config: toolNames.${key} must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`);
      }
    }

    // The checkpoint's own size cap (row knob `contextMaxRatio`), as a share of the
    // MESSAGE BUDGET the route leaves its window (window − reserved output) rather than
    // an absolute length: the same row reads the same way on a 64K route and on a 1M one.
    const contextMaxRatio = ours.contextMaxRatio ?? DEFAULT_CONTEXT_MAX_RATIO;
    if (!(typeof contextMaxRatio === 'number' && contextMaxRatio > 0 && contextMaxRatio <= 1)) {
      throw new Error(`dsh-fast-compact config: contextMaxRatio (${String(ours.contextMaxRatio)}) must be a number in (0, 1]`);
    }

    // How often the mount re-injects the plugin's own instruction (row knob
    // `pluginInstructionInject`); the modes and their window cost are documented
    // above, and the engine reads the resolved value to decide per step.
    const pluginInstructionInject = ours.pluginInstructionInject ?? DEFAULT_PLUGIN_INSTRUCTION_INJECT;
    if (!PLUGIN_INSTRUCTION_INJECT_MODES.includes(pluginInstructionInject)) {
      throw new Error(`dsh-fast-compact config: pluginInstructionInject must be one of ${PLUGIN_INSTRUCTION_INJECT_MODES.join(', ')} (got ${JSON.stringify(ours.pluginInstructionInject)})`);
    }

    return { thoughtChars, retainLength, refLineFormat, instructions, debug, debugChars, toolNames, contextMaxRatio, pluginInstructionInject };
  }

}