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
 * Base-package keys the row may name. All but one ride to the official engine
 * untouched; `thresholdRatio` is translated per route (see below), so this plugin
 * never re-decides WHEN to compact — it only re-expresses the same share against
 * the window the routed request actually gets.
 */
export const HOST_COMPACT_KEYS = Object.freeze([
  'thresholdRatio', 'retainRatio', 'retainTokens',
  'maxTokens', 'compactionRetries', 'maxOverflowRetries', 'modelPolicies', 'auto',
]);
/**
 * NOTE — `thresholdRatio` is the one host key this plugin re-expresses per route.
 * The row states it as a share of the route's USABLE message budget (its window
 * minus the output reservation the provider charges to that same window), which
 * is what the number has always meant to the user ("fire at 90% of what the route
 * can actually carry"). The base multiplies its ratio by the RAW window, so on a
 * route like strata-llm/64KB (W=65,535 with O=32,000 reserved) forwarding 0.9
 * unchanged makes the gate collapse to the structural ceiling W - O - B (at most
 * 33,535 = 51% of the window even with no headroom at all — 47% on the margin we
 * derive), which is why a 0.9 row used to fire at half the window.
 * `applyDerivedHeadroom` rewrites that ratio per route (and sizes the headroom
 * under it) so the base's own formula lands exactly on
 * `floor((W - O) * thresholdRatio)`; see deriveRoutePressure.
 */

/** Keys this plugin owns (everything else in the row is a typo and fails). */
export const FASTCOMPACT_KEYS = Object.freeze(['thoughtChars', 'retainLength', 'refLineFormat', 'instructions', 'debug', 'debugChars', 'toolNames', 'derivedHeadroom', 'contextMaxRatio']);

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
 * Split one row config into the plugin half and the host half, rejecting keys
 * neither side owns so a stale or misspelled row fails at mount. `headroomTokens`
 * is rejected on its own — in the row or inside one `modelPolicies` entry — because
 * this plugin now derives it from each route's context window.
 * @param {object} row - raw cordis row config.
 */
export function splitRowConfig(row) {
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
 * Derive BOTH pressure keys of one exact route from that route's own capacity.
 *
 * W = the route's adapter `contextWindow`, O = its adapter output default, and
 * U = W - O the message budget a routed request can actually carry. The base
 * gates at `floor(min(W * ratio, W - O - B))` — its ratio multiplies the RAW
 * window — so naming 0.9 on a 65,535/32,000 route asks for 58,981 message tokens,
 * which no request on that route can reach (U = 33,535): the gate silently falls
 * back to the structural ceiling U - B and compaction fires at ~half the window.
 * The row's ratio is a share of U instead, so this returns the pair the base must
 * be handed for ITS formula to land exactly on `floor(U * ratio)`:
 *
 *   B      = min(share, budgetCap, U - floor(U * ratio))   (clamped to >= 1)
 *   gate   = min(floor(U * ratio), U - B)                  (tokens)
 *   ratio' = gate / W                                      (so W * ratio' == gate)
 *
 * `FastCompactEngine.compactIfNeeded` also re-checks this gate against
 * `measurement.surfaceTokens`, so the envelope's tool schemas never count toward it.
 *
 * @param {number} contextWindow - positive adapter capacity for one exact route.
 * @param {number|null} thresholdRatio - share of the message budget that applies
 *   to that route, or null when the row names none (then only share/cap apply and
 *   no ratio is returned, so the row's own value rides untouched).
 * @param {number} defaultMaxTokens - adapter output default (0 when unknown).
 * @param {number} headroomRatio - share of W to reserve (row knob).
 * @returns {{ headroomTokens: number, thresholdRatio: number | null }}
 */
export function deriveRoutePressure(contextWindow, thresholdRatio = null, defaultMaxTokens = 0, headroomRatio = HEADROOM_RATIO) {
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
    return { headroomTokens: 1, thresholdRatio: null };
  }
  const share = Math.max(HEADROOM_MIN_TOKENS, Math.round(contextWindow * headroomRatio));
  const budgetCap = Math.max(1, Math.floor(budget * HEADROOM_MAX_BUDGET_SHARE));
  let headroom = Math.min(share, budgetCap);
  if (thresholdRatio === null) return { headroomTokens: Math.max(1, headroom), thresholdRatio: null };

  // The gate the row asks for, in tokens of that route's own message budget...
  const target = Math.floor(budget * thresholdRatio);
  // ... so the headroom must leave at least this much of the budget free, or the
  // base's window-side term would silently replace the ratio the user named.
  const margin = Math.max(1, budget - target);
  headroom = Math.max(1, Math.min(headroom, margin));
  const gate = Math.min(target, budget - headroom);
  if (gate < 1) return { headroomTokens: 1, thresholdRatio: null };
  // Hand the base back the equivalent window-relative ratio: its floor of
  // W * this value is exactly `gate`, and U - headroom >= gate keeps the other
  // term from binding.
  return { headroomTokens: headroom, thresholdRatio: gate / contextWindow };
}

/** The headroom half of deriveRoutePressure (kept as the tested standalone name). */
export function deriveHeadroomTokens(contextWindow, thresholdRatio = null, defaultMaxTokens = 0, headroomRatio = HEADROOM_RATIO) {
  return deriveRoutePressure(contextWindow, thresholdRatio, defaultMaxTokens, headroomRatio).headroomTokens;
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
 * @param {{ topLevel: number, perRoute: object[] }} derived - table from `index.mjs`.
 */
export function applyDerivedHeadroom(host, derived) {
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
  const perRoute = new Map();
  for (const [index, entry] of (derived.perRoute ?? []).entries()) {
    if (typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}] must be an object`);
    }
    const { provider, model } = entry;
    if (!derivedRouteKey(provider, model) || !Number.isInteger(entry.headroomTokens) || entry.headroomTokens < 1) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}] needs string provider/model and an integer headroomTokens >= 1`);
    }
    if ('thresholdRatio' in entry && (typeof entry.thresholdRatio !== 'number' || !(entry.thresholdRatio > 0 && entry.thresholdRatio <= 1))) {
      throw new Error(`dsh-fast-compact config: derivedHeadroom.perRoute[${index}].thresholdRatio must be a number in (0, 1]`);
    }
    // Only keys the base's modelPolicies schema admits — capacity facts the entry
    // may also carry stay out of the row and live on the engine for reporting.
    const policy = { provider, model, headroomTokens: entry.headroomTokens };
    if ('thresholdRatio' in entry) policy.thresholdRatio = entry.thresholdRatio;
    perRoute.set(`${provider}/${model}`, policy);
  }
  // The default ratio for routes the table never named: translated with the same
  // derivation against the tightest window we read (index.mjs), so an unlisted
  // route still gates at its own share of its usable budget rather than of W.
  const topLevelRatio = derived.topLevelThresholdRatio;
  if (topLevelRatio !== undefined && topLevelRatio !== null && !(typeof topLevelRatio === 'number' && topLevelRatio > 0 && topLevelRatio <= 1)) {
    throw new Error(`dsh-fast-compact config: derivedHeadroom.topLevelThresholdRatio (${String(topLevelRatio)}) must be a number in (0, 1]`);
  }
  const merged = policies.map((policy) => {
    const own = perRoute.get(`${policy.provider ?? ''}/${policy.model ?? ''}`);
    const next = { ...policy, headroomTokens: own?.headroomTokens ?? topLevel };
    if (own?.thresholdRatio !== undefined || topLevelRatio !== undefined) {
      next.thresholdRatio = own?.thresholdRatio ?? policy.thresholdRatio ?? topLevelRatio;
    }
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
  return hostOut;
}

/** Route key used by both halves of the merge (empty parts never match). */
function derivedRouteKey(provider, model) {
  return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== '';
}

/** Resolve the plugin half of the row against its defaults. */
export function resolveFastCompactConfig(row) {
  const { ours } = splitRowConfig(row);

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

  return { thoughtChars, retainLength, refLineFormat, instructions, debug, debugChars, toolNames, contextMaxRatio };
}
