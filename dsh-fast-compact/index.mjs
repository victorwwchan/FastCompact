/**
 * dsh-fast-compact — deterministic, zero-LLM compaction over the official base.
 *
 * Mount this row inside an agent preset's `compaction` isolate group in place
 * of another compaction engine. It is a subclass of
 * `@deepseek-ai/dsh-compaction-basic`'s `BasicCompactionEngine`: pressure
 * policy, token-meter pricing, range selection, retention, the durable
 * bracket transaction and shrink validation all stay with the official base.
 * This plugin replaces exactly one thing — the summary text. Instead of asking
 * a model to summarize the shadowed span, it compiles a fixed set of blocks
 * straight from the session log:
 *
 *  1. the newest runtime-context block (superseded copies dropped),
 *  2. the newest skill-catalog block (deduped),
 *  3. pinned content — EVERY human message of the compacted span (each clipped to
 *     `retainLength` chars, never dropped) plus entries the model recalled verbatim,
 *  4. the last state of work (files written, commands run, open errors),
 *  5. the last agent thought, quoted up to `thoughtChars` (0 = pointer only),
 *  6. session-log reference lines for every dropped tool call and result
 *     (`refLineFormat: 'thought' | 'none'`) — ONE cumulative index across the WHOLE
 *     session: older traffic is re-read straight from the log (the host's `compaction/summary`
 *     brackets name the ranges earlier compactions shadowed), so it keeps indexing even when
 *     some other backend wrote the body that replaced them; a call seq is indexed once,
 *     and row knob `contextMaxRatio` caps what the checkpoint may occupy of the MESSAGE
 *     BUDGET that route leaves its window (window − reserved output; the raw window only
 *     when the route names no budget)
 *  7. the session-log instruction block (config `instructions`, "" = off).
 *
 * No message or history text is carried: everything else stays in the session
 * log and comes back through `recall` / `recall_search` by seq. That is why
 * this row registers the recall tools and the `/recall` + `/fastcompact`
 * commands itself — a preset swapping to this row keeps them working.
 *
 * Host-only: no client bundle, no settings namespace, no UI slots. All
 * configuration comes from the cordis row. Harness classes are resolved through
 * the RUNNING dsh install (never a second npm copy) by `lib/runtime.mjs`.
 *
 * @module dsh-fast-compact
 */

import { loadRuntime, TESTED_DSH_VERSIONS } from './lib/runtime.mjs';
import { createEngineClass, ENGINE_PROVIDER, ENGINE_MODEL, LOG_PREFIX } from './lib/engine.mjs';
import { resolveFastCompactConfig, splitRowConfig, FASTCOMPACT_KEYS, HOST_COMPACT_KEYS, deriveRoutePressure, HEADROOM_RATIO, HEADROOM_FALLBACK_TOKENS } from './lib/config.mjs';
import { defineRecallTools, registerCommands, DEFAULT_TOOL_NAMES } from './lib/tools.mjs';

export const name = 'dsh-fast-compact';
export const inject = ['tokenMeter', 'sessions', 'llm'];

/** Plugin-level keys handled here and never passed into the engine row. */
const PLUGIN_KEYS = ['harnessEntry', 'allowUntestedHarness', 'recallToolName', 'searchToolName', 'maxRecallChars', 'maxSearchHits', 'headroomRatio'];

/** Default recall budgets; a row may raise or lower either one. */
const DEFAULT_MAX_RECALL_CHARS = 60_000;
const DEFAULT_MAX_SEARCH_HITS = 40;

function toolName(value, fallback, key) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value)) {
    throw new Error(`dsh-fast-compact config: ${key} must match /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/`);
  }
  return value;
}

function positiveInt(value, fallback, key) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-fast-compact config: ${key} must be an integer >= 1`);
  }
  return value;
}

/** Headroom is derived, never hand-set: the row may only re-weight the share. */
function headroomRatioValue(value) {
  if (value === undefined || value === null) return HEADROOM_RATIO;
  if (typeof value !== 'number' || !(value > 0 && value < 1)) {
    throw new Error(`dsh-fast-compact config: headroomRatio (${String(value)}) must be a number in (0, 1)`);
  }
  return value;
}

/** Providers whose model list is longer than this are not interrogated per model. */
const MAX_ENUMERATED_MODELS = 64;

/**
 * Read every route's capacity through the llm service and derive its pressure pair
 * (headroom + window-relative ratio). The row's `thresholdRatio` is a share of the
 * route's USABLE message budget (W - O); the base multiplies its ratio by the RAW
 * window, so each route needs its own translated ratio and a headroom small enough
 * to leave that gate reachable — a fixed count or a fixed ratio is wrong for
 * everything but one window size. Routes are catalog-driven: adapters answer
 * without any request; an endpoint that cannot be interrogated keeps the fallback.
 * @param {object} ctx - cordis context inside the compaction isolate realm.
 * @param {{ thresholdRatio?: number, modelPolicies?: object[] }} row - host half of the row.
 * @param {number} headroomRatio - share of each window to reserve.
 * @returns {{ topLevel: number, topLevelThresholdRatio: number|null, perRoute: object[] } | null}
 *   - null = no capacity service; perRoute entries carry provider/model plus the
 *   derived headroomTokens/thresholdRatio and the raw contextWindow/defaultMaxTokens
 *   the engine reports in its debug stats.
 */
async function resolveHeadroomTable(ctx, row, headroomRatio) {
  const llm = ctx?.get?.('llm') ?? ctx?.llm;
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return null;

  // Which ratio applies to which route decides whether the derived headroom is
  // shrunk so that ratio actually governs the gate.
  const rowRatio = typeof row.thresholdRatio === 'number' ? row.thresholdRatio : null;
  const ratios = new Map();
  if (Array.isArray(row.modelPolicies)) {
    for (const policy of row.modelPolicies) {
      if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) continue;
      if (typeof policy.thresholdRatio === 'number') ratios.set(`${policy.provider}/${policy.model}`, policy.thresholdRatio);
    }
  }

  const warn = (message) => ctx.logger.warn(`${LOG_PREFIX} ${message}`);
  let providers = [];
  try {
    providers = await llm.listProviders();
  } catch (error) {
    warn(`route capacities unavailable (${String(error.message)}); headroom stays at the fixed fallback`);
    return null;
  }

  const perRoute = [];
  const windows = [];
  for (const provider of providers ?? []) {
    const providerId = typeof provider === 'object' ? provider.id : undefined;
    if (!providerId) continue;
    let models;
    try {
      models = await llm.listModels(providerId);
    } catch (error) {
      warn(`provider ${providerId} cannot be listed (${String(error.message)}); its routes keep the fallback headroom`);
      continue;
    }
    if (!Array.isArray(models)) continue;
    if (models.length > MAX_ENUMERATED_MODELS) {
      warn(`provider ${providerId} lists ${models.length} models (> ${MAX_ENUMERATED_MODELS}); its routes keep the fallback headroom`);
      continue;
    }
    for (const entry of models) {
      const modelId = typeof entry === 'object' ? entry.id : undefined;
      if (!modelId) continue;
      let info;
      try {
        info = await llm.resolveModelInfo(providerId, modelId);
      } catch (error) {
        warn(`route ${providerId}/${modelId} has no readable capacity (${String(error.message)}); it keeps the fallback headroom`);
        continue;
      }
      const contextWindow = typeof info === 'object' ? info.context?.contextWindow : undefined;
      if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
        // Nothing to derive from: that route never gates pressure at all (the base
        // reports "no context capacity for ..."), so leave it out of the table.
        continue;
      }
      const ratio = ratios.get(`${providerId}/${modelId}`) ?? rowRatio;
      try {
        const pressure = deriveRoutePressure(contextWindow, ratio, info.defaultMaxTokens ?? 0, headroomRatio);
        perRoute.push({
          provider: providerId,
          model: modelId,
          contextWindow,
          defaultMaxTokens: info.defaultMaxTokens ?? 0,
          headroomTokens: pressure.headroomTokens,
          ...(pressure.thresholdRatio === null ? {} : { thresholdRatio: pressure.thresholdRatio }),
        });
        windows.push(contextWindow);
      } catch (error) {
        warn(`derived pressure for ${providerId}/${modelId} rejected (${String(error.message)}); it keeps the fallback`);
      }
    }
  }

  // The default for routes the table does not name: margin and ratio sized for the
  // TIGHTEST window we read, so an unlisted route can never carry a headroom bigger
  // than its own budget, nor a ratio whose gate it could not reach. With no output
  // default known for that hypothetical route, O = 0 keeps the share honest (a
  // window-relative ratio identical to the row's).
  const tightest = windows.reduce((min, window) => Math.min(min, window), Number.MAX_SAFE_INTEGER);
  if (windows.length === 0) return { topLevel: HEADROOM_FALLBACK_TOKENS, topLevelThresholdRatio: null, perRoute };
  const topPressure = deriveRoutePressure(tightest, rowRatio, 0, headroomRatio);
  return {
    topLevel: topPressure.headroomTokens,
    topLevelThresholdRatio: topPressure.thresholdRatio,
    perRoute,
  };
}

/**
 * Plugin entry.
 * @param ctx - cordis context (inside the preset's compaction isolate realm).
 * @param config - cordis row config.
 */
export async function apply(ctx, config = {}) {
  const row = config ?? {};
  for (const [key, value] of Object.entries(row)) {
    // `headroomTokens` deliberately rides through to `splitRowConfig` below so it
    // fails with the actionable "derive it instead" message, not a generic one.
    if (key === 'headroomTokens') continue;
    if (PLUGIN_KEYS.includes(key) || FASTCOMPACT_KEYS.includes(key) || HOST_COMPACT_KEYS.includes(key)) continue;
    throw new Error(`dsh-fast-compact config: unknown key "${key}" (plugin keys: ${PLUGIN_KEYS.join(', ')}; engine keys: ${[...FASTCOMPACT_KEYS, ...HOST_COMPACT_KEYS].join(', ')})`);
  }

  // Validate this package's own keys up front so a bad row fails at mount with
  // a clear message (the engine constructor repeats the check on its own half).
  const plugin = {};
  const engineRow = {};
  for (const [key, value] of Object.entries(row)) {
    if (PLUGIN_KEYS.includes(key)) plugin[key] = value;
    else engineRow[key] = value;
  }
  const resolvedConfig = resolveFastCompactConfig(engineRow);

  const names = {
    recall: toolName(plugin.recallToolName, DEFAULT_TOOL_NAMES.recall, 'recallToolName'),
    search: toolName(plugin.searchToolName, DEFAULT_TOOL_NAMES.search, 'searchToolName'),
  };
  const budgets = {
    maxRecallChars: positiveInt(plugin.maxRecallChars, DEFAULT_MAX_RECALL_CHARS, 'maxRecallChars'),
    maxSearchHits: positiveInt(plugin.maxSearchHits, DEFAULT_MAX_SEARCH_HITS, 'maxSearchHits'),
  };
  const headroomRatio = headroomRatioValue(plugin.headroomRatio);

  // Load the harness classes from the running dsh install; its own version gate
  // and API contract check run here.
  const allowUntested = plugin.allowUntestedHarness === true;
  const runtime = await loadRuntime(plugin.harnessEntry, { allowUntested });
  if (runtime.versionStatus !== 'tested') {
    ctx.logger.warn(`${LOG_PREFIX} dsh ${runtime.version ?? '(unknown version)'} has not been tested with this plugin (tested: ${TESTED_DSH_VERSIONS.join(', ')}); the API contract check passed, loading anyway`);
  }

  const Engine = createEngineClass(runtime);

  // Derive the base's absolute headroom from every route's own window. A fixed
  // token count in the row only fits one model size: sized for a huge window it
  // collapses the gate on a local one (compaction fires before almost every step)
  // or leaves no pressure budget at all. The capacities come from the same
  // adapter metadata the base prices against, so the two never drift apart.
  const headroomTable = await resolveHeadroomTable(ctx, engineRow, headroomRatio);
  if (headroomTable === null) {
    ctx.logger.warn(`${LOG_PREFIX} no route capacity service in this realm; headroom falls back to ${HEADROOM_FALLBACK_TOKENS} tokens for every route`);
  }

  // Provide ctx.compaction. cordis constructs the class with (ctx, config) and
  // unregisters it when this fiber unloads; the recall tool names reach the
  // engine so reference lines can name the tool that restores a seq, and the
  // derived table reaches it as `derivedHeadroom`, which its constructor merges
  // into the host half before it rides to the base.
  ctx.plugin(Engine, { ...engineRow, derivedHeadroom: headroomTable, toolNames: names });

  ctx.inject(['tools'], (toolCtx) => {
    for (const definition of defineRecallTools(runtime, budgets, names)) {
      toolCtx.effect(() => toolCtx.tools.register(definition), `${name} ${definition.name} tool`);
    }
  });

  // Needs the engine (ctx.compaction) this row provides and the command registry.
  ctx.inject(['commands', 'compaction'], (commandCtx) => {
    const warn = (message) => commandCtx.logger.warn(`${LOG_PREFIX} ${message}; continuing without it`);
    commandCtx.effect(() => registerCommands(commandCtx, budgets, warn), `${name} commands`);
  });

  // Mount log states the ACTUAL gate each route now fires at, in tokens and as a
  // share of both the raw window and the usable message budget — the numbers the
  // row's ratio translates to, so a "0.9 that fires at 0.5" report is answerable
  // from one line instead of by re-deriving the base's formula.
  const rowRatioForLabel = typeof engineRow.thresholdRatio === 'number' ? engineRow.thresholdRatio : null;
  const gateOf = (entry) => {
    const budget = entry.contextWindow - (entry.defaultMaxTokens ?? 0);
    if (typeof entry.thresholdRatio === 'number') return Math.floor(entry.contextWindow * entry.thresholdRatio);
    const target = rowRatioForLabel === null ? null : Math.floor(budget * rowRatioForLabel);
    return Math.min(target ?? Number.MAX_SAFE_INTEGER, budget - entry.headroomTokens);
  };
  const pressureLabel = (entry) => {
    const budget = entry.contextWindow - (entry.defaultMaxTokens ?? 0);
    const gate = gateOf(entry);
    return `${entry.provider}/${entry.model} W=${entry.contextWindow} O=${entry.defaultMaxTokens ?? 0} headroom ${entry.headroomTokens} -> gate ${gate} tok (${((gate / entry.contextWindow) * 100).toFixed(1)}% of W, ${((gate / budget) * 100).toFixed(1)}% of the ${budget}-token message budget)`;
  };
  const perRoute = headroomTable?.perRoute ?? [];
  const headroomSummary = headroomTable === null
    ? `headroom ${HEADROOM_FALLBACK_TOKENS} tokens, row ratio forwarded untouched (no capacity service)`
    : (() => {
        const listed = perRoute.slice(0, 8).map(pressureLabel).join('; ');
        const more = perRoute.length > 8 ? `; +${perRoute.length - 8} more route(s)` : '';
        const ratioNote = headroomTable.topLevelThresholdRatio === null
          ? `no route ratio named (the base default governs unlisted routes)`
          : `thresholdRatio is a share of each message budget (${rowRatioForLabel === null ? 'base default' : rowRatioForLabel} where the row names none)`;
        return `pressure derived per window (${(headroomRatio * 100).toFixed(1)}% headroom, budget-capped): default headroom ${headroomTable.topLevel}; ${ratioNote}; ${perRoute.length} route(s): ${listed}${more}`;
      })();

  ctx.logger.info(
    `${LOG_PREFIX} loaded on dsh ${runtime.version ?? '(unknown version)'}; `
    + `engine ${ENGINE_PROVIDER}/${ENGINE_MODEL}, refLineFormat ${resolvedConfig.refLineFormat}, thoughtChars ${resolvedConfig.thoughtChars}, retainLength ${resolvedConfig.retainLength}, contextMaxRatio ${resolvedConfig.contextMaxRatio}, `
    + `debug ${resolvedConfig.debug ? 'on' : 'off'}, instructions ${resolvedConfig.instructions === '' ? 'off' : 'on'}`
    + `; tools ${names.recall}, ${names.search}; commands /recall, /fastcompact; ${headroomSummary}`,
  );
}
