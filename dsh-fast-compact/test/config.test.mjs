/**
 * Config tests for the row surface this plugin owns (no harness needed).
 *
 * The row carries two halves: the official base-compact keys (forwarded
 * untouched to `BasicCompactionEngine`) and this plugin's content keys. The
 * plugin half is exactly nine keys — `thoughtChars`, `retainLength`, `refLineFormat`,
 * `instructions`, `debug`, `debugChars`, `toolNames` plus the `derivedHeadroom`
 * table `index.mjs` fills in — and anything else fails at mount, so a stale row
 * from the old vendored surface (`toolRefs`, `refThoughtChars`,
 * `lastThinkingChars`, …) cannot silently fall back to a default. TWO base keys
 * are not forwarded as written: `headroomTokens` is derived per route, `thresholdRatio`
 * rides untouched as a share of that route's WINDOW, and `maxTokens` (the summary's
 * output cap) is filled in per route from that same share when the row left it out.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveFastCompactConfig, splitRowConfig, FASTCOMPACT_KEYS, HOST_COMPACT_KEYS, DEFAULT_THOUGHT_CHARS, DEFAULT_RETAIN_LENGTH, DEFAULT_DEBUG, DEFAULT_DEBUG_CHARS, DEFAULT_CONTEXT_MAX_RATIO, REF_LINE_FORMATS, deriveRoutePressure, deriveHeadroomTokens, applyDerivedHeadroom, HEADROOM_RATIO, HEADROOM_MIN_TOKENS, HEADROOM_MAX_BUDGET_SHARE, HEADROOM_FALLBACK_TOKENS } from '../lib/config.mjs';

test('config: defaults are one thought quote of 200 chars, thought-shaped refs, built-in instruction', () => {
  const config = resolveFastCompactConfig({});
  assert.equal(config.thoughtChars, DEFAULT_THOUGHT_CHARS, 'thoughtChars default is 200');
  assert.equal(config.retainLength, DEFAULT_RETAIN_LENGTH, 'retainLength default is 200');
  assert.equal(config.refLineFormat, 'thought', 'default label shape quotes the governing thought');
  assert.equal(config.instructions, undefined, 'undefined means the built-in instruction block');
  assert.deepEqual({ ...config.toolNames }, {}, 'no tool names by default (the compiler falls back)');
});

test('config: retainLength is an adjustable integer knob for kept human text', () => {
  assert.equal(resolveFastCompactConfig({ retainLength: 80 }).retainLength, 80, 'a shorter pin clip is accepted');
  assert.equal(resolveFastCompactConfig({ retainLength: 2_000 }).retainLength, 2_000, 'a longer one too');
});

test('config: retainLength below 1 fails (a pinned user message keeps words)', () => {
  for (const value of [0, -1, 12.5, '200', {}]) {
    assert.throws(
      () => resolveFastCompactConfig({ retainLength: value }),
      /retainLength .* must be an integer >= 1/,
      `value ${JSON.stringify(value)} rejected`,
    );
  }
});

test('config: thoughtChars is an adjustable non-negative integer knob', () => {
  assert.equal(resolveFastCompactConfig({ thoughtChars: 0 }).thoughtChars, 0, 'zero keeps the pointer only');
  assert.equal(resolveFastCompactConfig({ thoughtChars: 800 }).thoughtChars, 800, 'a longer quote is accepted');
});

test('config: a negative or fractional thoughtChars fails', () => {
  for (const value of [-1, 12.5, '200', {}]) {
    assert.throws(
      () => resolveFastCompactConfig({ thoughtChars: value }),
      /thoughtChars .* must be an integer >= 0/,
      `value ${JSON.stringify(value)} rejected`,
    );
  }
});

test('config: refLineFormat accepts only the two shipped shapes', () => {
  for (const value of REF_LINE_FORMATS) {
    assert.equal(resolveFastCompactConfig({ refLineFormat: value }).refLineFormat, value, `${value} accepted`);
  }
  for (const value of ['default', 'range', '', 0]) {
    assert.throws(
      () => resolveFastCompactConfig({ refLineFormat: value }),
      /refLineFormat must be one of/,
      `value ${JSON.stringify(value)} rejected`,
    );
  }
});

test('config: instructions is a string; "" disables the block, undefined keeps the built-in one', () => {
  assert.equal(resolveFastCompactConfig({ instructions: 'keep working from the thought' }).instructions, 'keep working from the thought', 'custom text kept verbatim');
  assert.equal(resolveFastCompactConfig({ instructions: '' }).instructions, '', 'empty string means off');
  for (const value of [42, [], {}]) {
    assert.throws(() => resolveFastCompactConfig({ instructions: value }), /instructions must be a string/, `value ${JSON.stringify(value)} rejected`);
  }
});

test('config: toolNames must be well-formed tool identifiers', () => {
  const config = resolveFastCompactConfig({ toolNames: { recall: 'fc_recall', search: 'fc_search' } });
  assert.deepEqual({ ...config.toolNames }, { recall: 'fc_recall', search: 'fc_search' }, 'names kept');
  assert.throws(() => resolveFastCompactConfig({ toolNames: { recall: 'bad name!' } }), /toolNames\.recall must match/, 'invalid name rejected');
  assert.throws(() => resolveFastCompactConfig({ toolNames: ['recall'] }), /toolNames must be an object/, 'array rejected');
});

test('config: the official base keys are forwarded untouched', () => {
  const row = { thresholdRatio: 0.8, retainRatio: 0.35, retainTokens: 0, maxTokens: 0, compactionRetries: 2, maxOverflowRetries: 3, auto: true, modelPolicies: {}, thoughtChars: 120 };
  const { ours, host } = splitRowConfig(row);
  assert.equal(host.thresholdRatio, 0.8, 'pressure key forwarded');
  assert.equal(host.auto, true, 'auto key forwarded');
  assert.deepEqual(Object.keys(host).sort(), [...HOST_COMPACT_KEYS].filter((key) => key in row).sort(), 'exactly the row’s host keys');
  assert.deepEqual({ ...ours }, { thoughtChars: 120 }, 'plugin half holds only plugin keys');
});

test('config: headroomTokens is not a row key any more (top level, or inside one policy)', () => {
  assert.throws(
    () => splitRowConfig({ thresholdRatio: 0.7, headroomTokens: 4096 }),
    /headroomTokens is not a row key any more/,
    'top-level headroom rejected',
  );
  assert.throws(
    () => splitRowConfig({ modelPolicies: [{ provider: 'strata-llm', model: '120KB', headroomTokens: 4096 }] }),
    /modelPolicies\[0\]\.headroomTokens is not a row key any more/,
    'per-policy headroom rejected',
  );
});

test('config: derived headroom is a share of the route window, floored and budget-capped', () => {
  assert.equal(deriveHeadroomTokens(122_880, null, 0, HEADROOM_RATIO), Math.round(122_880 * HEADROOM_RATIO), 'plain share of W when no ratio is named');
  assert.equal(deriveHeadroomTokens(1_000, null, 0, HEADROOM_RATIO), Math.floor(1_000 * HEADROOM_MAX_BUDGET_SHARE), 'a tiny window is capped by its own budget, not by the floor');
  const capped = deriveHeadroomTokens(8_000, null, 6_000, HEADROOM_RATIO);
  assert.equal(capped, Math.floor(2_000 * HEADROOM_MAX_BUDGET_SHARE), 'headroom never eats more than a quarter of the message budget');
  assert.equal(deriveHeadroomTokens(8_000, null, 8_000, HEADROOM_RATIO), 1, 'a window fully reserved for output keeps headroom minimal and lets the base report it');
});

test('config: a named ratio governs its own share of the MESSAGE BUDGET, not of W', () => {
  // strata-llm/120KB: W=122880, O=32000 -> budget 90880. The 4% share (4915) fits
  // inside the 0.6 share, so nothing shrinks and the gate is the row's own number.
  assert.equal(deriveHeadroomTokens(122_880, 0.6, 32_000, HEADROOM_RATIO), Math.round(122_880 * HEADROOM_RATIO), 'share fits under a budget-relative ratio');
  // ratio .7 of the BUDGET leaves 30% (27264) free — far more than the 4% share, so
  // unlike the old window-relative rule this route needs no shrink at all.
  assert.equal(deriveHeadroomTokens(122_880, 0.7, 32_000, HEADROOM_RATIO), Math.round(122_880 * HEADROOM_RATIO), 'no shrink: the share fits under the budget share');
  // strata-llm/100KB: W=102400, O=32000 -> budget 70400; share 4096 stays.
  assert.equal(deriveHeadroomTokens(102_400, 0.65, 32_000, HEADROOM_RATIO), 4_096, 'headroom = share');
  // strata-llm/64KB: W=65535 with O=32000 reserved — the route that made the old
  // rule unreachable. budget 33535, share 2621, gate floor(33535*0.6) = 20121.
  assert.equal(deriveHeadroomTokens(65_535, 0.6, 32_000, HEADROOM_RATIO), Math.round(65_535 * HEADROOM_RATIO), 'the tight route keeps its honest share');
  // A llama-cpp route with no declared output default: budget = W, so a budget
  // share is a window share and the ratio rides unchanged.
  assert.equal(deriveHeadroomTokens(84_000, 0.6, 0, HEADROOM_RATIO), Math.round(84_000 * HEADROOM_RATIO), 'share governs; gate = 0.6W');
});

test('config: the gate is the row share of the WINDOW, whatever the reply reservation is', () => {
  // The plugin's OWN comparison (meter surface vs ceil(W * ratio)) must not move
  // with the output reservation, and must stay at or above wherever the base's
  // formula lands — otherwise a route would compact earlier than the row asked.
  const baseGate = (window, ratio, headroom, output) => Math.floor(Math.min(window * ratio, window - output - headroom));
  for (const [window, output, rowRatio] of [[65_535, 32_000, 0.9], [65_535, 32_000, 0.6], [122_880, 32_000, 0.9], [102_400, 32_000, 0.7], [84_000, 0, 0.6], [8_000, 6_000, 0.5]]) {
    const pressure = deriveRoutePressure(window, rowRatio, output, HEADROOM_RATIO);
    const budget = window - output;
    const requested = Math.ceil(window * rowRatio);
    const ceiling = budget - pressure.headroomTokens;
    assert.equal(pressure.gateTokens, Math.min(requested, Math.max(1, ceiling)), `gate = the row's ${rowRatio} of W=${window}, clamped to the ${ceiling}-token ceiling its messages can reach`);
    assert.equal(pressure.requestedGateTokens, requested, 'the raw share is reported untouched beside the effective gate');
    assert.equal(pressure.thresholdRatio, rowRatio, 'the ratio rides untouched: same window basis every report prints');
    const base = baseGate(window, pressure.thresholdRatio, pressure.headroomTokens, output);
    assert.ok(base <= pressure.gateTokens, `the base's own min() lands at ${base}, never past the gate ${pressure.gateTokens} that governs here`);
    assert.equal(pressure.clampedToCeiling, requested > ceiling, `the clamp flag says whether W=${window} could reach the share`);
    assert.equal(pressure.beyondBudget, requested > budget, `a share past the ${budget}-token message budget is reported as borrowed time on W=${window}`);
  }
  // The 64KB route the user hit: 0.9 names 90% of the WINDOW, and its messages
  // cannot get there — so the gate lands at the last reachable step and says so.
  const tight = deriveRoutePressure(65_535, 0.9, 32_000, HEADROOM_RATIO);
  assert.equal(tight.requestedGateTokens, Math.ceil(65_535 * 0.9), 'row 0.9 wants 90% of the 65,535-token window: 58,982 tokens of messages');
  assert.equal(tight.gateTokens, 30_914, 'its messages top out at 33,535 - 2,621 headroom, so the gate lands there (pressure fires at the last reachable step)');
  assert.ok(tight.clampedToCeiling, 'the clamp is reported, not hidden somewhere else');
  assert.equal(tight.thresholdRatio, 0.9, 'the row number is the gate basis verbatim — no translation against the budget');
  assert.ok(tight.beyondBudget, 'that share sits past the 33,535-token message budget: pressure here runs on borrowed time');
});

test('config: the summary cap auto-aligns to the same share (no hand-written maxTokens)', () => {
  for (const [window, output, rowRatio] of [[122_880, 32_000, 0.7], [65_535, 32_000, 0.9], [102_400, 32_000, 0.65], [8_000, 6_000, 0.5], [84_000, 0, 0.6]]) {
    const pressure = deriveRoutePressure(window, rowRatio, output, HEADROOM_RATIO);
    const free = Math.max(HEADROOM_MIN_TOKENS, window - pressure.gateTokens);
    assert.equal(pressure.outputCapTokens, output > 0 ? Math.min(output, free) : free, `cap = min(adapter default ${output}, W - gate = ${free}) on W=${window}`);
    assert.ok(pressure.outputCapTokens + pressure.gateTokens <= window, `gate ${pressure.gateTokens} + summary ${pressure.outputCapTokens} never over-requests the ${window}-token window`);
  }
  const none = deriveRoutePressure(122_880, null, 32_000, HEADROOM_RATIO);
  assert.equal(none.outputCapTokens, null, 'no share named: nothing to align to, so the base keeps its own reservation');
});

test('config: the aligned cap lands on each policy; a hand-written maxTokens wins', () => {
  const host = { retainRatio: 0.12, modelPolicies: [{ provider: 'strata-llm', model: '64KB' }] };
  const derived = {
    topLevel: 2_621,
    topLevelThresholdRatio: 0.7,
    topLevelOutputCap: 32_768,
    perRoute: [
      { provider: 'strata-llm', model: '120KB', contextWindow: 122_880, defaultMaxTokens: 32_000, headroomTokens: 4_915, thresholdRatio: 0.7, outputCapTokens: 32_000 },
    ],
  };
  const merged = applyDerivedHeadroom(host, derived);
  assert.equal(merged.maxTokens, 32_768, 'row left maxTokens out: the tightest-window share fills it');
  assert.equal(merged.modelPolicies[0].maxTokens, 32_768, 'an unlisted route takes that top-level cap');
  assert.equal(merged.modelPolicies[1].maxTokens, 32_000, 'a named route takes its own aligned cap (adapter default was the tighter term)');
  assert.equal('contextWindow' in merged.modelPolicies[1], false, 'capacity facts still stay out of the base’s policy schema');
  const handSet = applyDerivedHeadroom({ ...host, maxTokens: 8192 }, derived);
  assert.equal(handSet.maxTokens, 8192, 'a row that still writes maxTokens keeps its own value');
  assert.equal(handSet.modelPolicies[0].maxTokens, undefined, 'and no derived cap is injected beside it: that policy inherits the row’s own value');
});

test('config: the row ratio rides into the modelPolicies entry of each route', () => {
  const host = { thresholdRatio: 0.6, retainRatio: 0.12, modelPolicies: [{ provider: 'strata-llm', model: '120KB', retainRatio: 0.3 }] };
  const derived = {
    topLevel: 4_915,
    topLevelThresholdRatio: 0.6,
    perRoute: [
      { provider: 'strata-llm', model: '120KB', contextWindow: 122_880, defaultMaxTokens: 32_000, headroomTokens: 4_915, thresholdRatio: 0.6 },
      { provider: 'strata-llm', model: '64KB', contextWindow: 65_535, defaultMaxTokens: 32_000, headroomTokens: 2_621, thresholdRatio: 0.9 },
    ],
  };
  const merged = applyDerivedHeadroom(host, derived);
  assert.equal(merged.headroomTokens, 4_915, 'row-level headroom');
  assert.equal(merged.thresholdRatio, 0.6, 'unlisted routes keep the row share of the window');
  assert.deepEqual(merged.modelPolicies[0], { provider: 'strata-llm', model: '120KB', retainRatio: 0.3, headroomTokens: 4_915, thresholdRatio: 0.6 }, 'existing policy kept its other keys and took the row share verbatim');
  assert.equal(merged.modelPolicies[1].provider, 'strata-llm', 'unlisted route appended with its own pair');
  assert.equal(merged.modelPolicies[1].thresholdRatio, 0.9, 'and its own window share, untranslated');
  assert.equal('contextWindow' in merged.modelPolicies[1], false, 'capacity facts stay out of the base’s policy schema');
});

test('config: derived headroom rejects nonsense capacity inputs', () => {
  assert.throws(() => deriveHeadroomTokens(0, null, 0, HEADROOM_RATIO), /positive integer contextWindow/, 'zero window rejected');
  assert.throws(() => deriveHeadroomTokens('120KB', null, 0, HEADROOM_RATIO), /positive integer contextWindow/, 'string window rejected');
  assert.throws(() => deriveHeadroomTokens(122_880, 1.5, 0, HEADROOM_RATIO), /thresholdRatio in \(0, 1\]/, 'ratio out of range');
  assert.throws(() => deriveHeadroomTokens(122_880, null, -1, HEADROOM_RATIO), /non-negative integer output default/, 'negative output cap');
  assert.throws(() => deriveHeadroomTokens(122_880, null, 0, 0), /headroomRatio .* must be a number in \(0, 1\)/, 'zero share');
});

test('config: the derived table folds into modelPolicies and appends unlisted routes', () => {
  const host = { thresholdRatio: 0.6, retainRatio: 0.12, maxTokens: 8192, auto: true, modelPolicies: [{ provider: 'strata-llm', model: '120KB', thresholdRatio: 0.7 }] };
  const derived = {
    topLevel: 2621,
    perRoute: [
      { provider: 'strata-llm', model: '120KB', headroomTokens: 4864 },
      { provider: 'llama-cpp', model: '84k', headroomTokens: 3360 },
    ],
  };
  const merged = applyDerivedHeadroom(host, derived);
  assert.equal(merged.headroomTokens, 2621, 'row-level headroom from the tightest window read');
  assert.deepEqual(merged.modelPolicies, [
    { provider: 'strata-llm', model: '120KB', thresholdRatio: 0.7, headroomTokens: 4864 },
    { provider: 'llama-cpp', model: '84k', headroomTokens: 3360 },
  ], 'existing policy kept its ratio and took its own headroom; unlisted route appended');
  assert.equal(host.thresholdRatio, 0.6, 'host half never mutated');

  const bare = applyDerivedHeadroom({ auto: true }, undefined);
  assert.equal(bare.headroomTokens, HEADROOM_FALLBACK_TOKENS, 'no table falls back to the documented constant, never the base default');
  assert.deepEqual(bare.modelPolicies, [], 'no policies invented out of thin air');
});

test('config: a malformed derived table fails instead of riding to the base', () => {
  assert.throws(() => applyDerivedHeadroom({}, { topLevel: 0 }), /derivedHeadroom\.topLevel/, 'zero default rejected');
  assert.throws(() => applyDerivedHeadroom({}, { topLevel: 4096, perRoute: [{ provider: '', model: 'x', headroomTokens: 10 }] }), /needs string provider\/model/, 'empty provider rejected');
  assert.throws(() => applyDerivedHeadroom({}, { topLevel: 4096, perRoute: [{ provider: 'p', model: 'm', headroomTokens: 2.5 }] }), /integer headroomTokens/, 'fractional headroom rejected');
  assert.throws(() => applyDerivedHeadroom({}, []), /derivedHeadroom must be an object/, 'array rejected');
});

test('config: the debug trail is opt-in, and its text cap is a non-negative integer', () => {
  const defaults = resolveFastCompactConfig({});
  assert.equal(defaults.debug, DEFAULT_DEBUG, 'debug defaults off');
  assert.equal(defaults.debugChars, DEFAULT_DEBUG_CHARS, 'debugChars default matches');
  const row = splitRowConfig({ debug: true, debugChars: 5 });
  assert.equal(row.ours.debug, true, 'debug lands in the plugin half');
  assert.equal(row.ours.debugChars, 5, 'debugChars lands in the plugin half');
  assert.equal(row.host.debug, undefined, 'debug never rides to the base engine');
  assert.throws(() => resolveFastCompactConfig({ debug: 'yes' }), /debug must be a boolean/s, 'string debug rejected');
  assert.equal(resolveFastCompactConfig({ debug: null }).debug, DEFAULT_DEBUG, 'null means unset (falls back to the default)');
  assert.throws(() => resolveFastCompactConfig({ debugChars: -1 }), /debugChars .* must be an integer >= 0/s, 'negative cap rejected');
  assert.throws(() => resolveFastCompactConfig({ debugChars: 12.5 }), /debugChars .* must be an integer >= 0/s, 'fractional cap rejected');
  assert.equal(resolveFastCompactConfig({ debug: true, debugChars: 0 }).debugChars, 0, 'zero cap means seqs only');
});

test("config: the checkpoint cap is a ratio of the route's message budget, not an absolute length", () => {
  assert.equal(resolveFastCompactConfig({}).contextMaxRatio, DEFAULT_CONTEXT_MAX_RATIO, 'default caps the body at a quarter of the budget');
  assert.equal(resolveFastCompactConfig({ contextMaxRatio: 0.1 }).contextMaxRatio, 0.1, 'a tighter share is accepted');
  assert.equal(resolveFastCompactConfig({ contextMaxRatio: 1 }).contextMaxRatio, 1, 'a full budget is the upper bound');
  assert.equal(splitRowConfig({ contextMaxRatio: 0.2 }).ours.contextMaxRatio, 0.2, 'the knob lands in the plugin half');
  assert.equal(splitRowConfig({ contextMaxRatio: 0.2 }).host.contextMaxRatio, undefined, 'it never rides to the base engine');
  for (const bad of [0, 1.5, -0.1, '0.2']) {
    assert.throws(() => resolveFastCompactConfig({ contextMaxRatio: bad }), /contextMaxRatio .* must be a number in \(0, 1\]/s, `${bad} rejected`);
  }
  // Ratio-only: naming a byte/token length instead is a typo we refuse, so a row
  // can never grow its own summary past the share of the window it asked for.
  assert.throws(() => splitRowConfig({ contextMaxLength: 4000 }), /unknown key "contextMaxLength"/s, 'an absolute length is not a row key');
});

test('config: a key neither side owns fails at mount', () => {
  for (const stale of ['toolRefs', 'refThoughtChars', 'lastThinkingChars', 'lastThinkingMode', 'sessionLogInstruction', 'statsLog', 'maxRequestBytes']) {
    assert.throws(
      () => splitRowConfig({ [stale]: 1 }),
      new RegExp(`unknown key "${stale}"`, 's'),
      `${stale} rejected`,
    );
  }
});

test('config: the owned-key list is the only source of truth for both halves', () => {
  assert.deepEqual([...FASTCOMPACT_KEYS], ['thoughtChars', 'retainLength', 'refLineFormat', 'instructions', 'debug', 'debugChars', 'toolNames', 'derivedHeadroom', 'contextMaxRatio'], 'nine owned keys');
  const overlap = FASTCOMPACT_KEYS.filter((key) => HOST_COMPACT_KEYS.includes(key));
  assert.deepEqual(overlap, [], 'halves are disjoint');
  assert.equal(HOST_COMPACT_KEYS.includes('headroomTokens'), false, 'the base default headroom is no longer reachable from a row');
});
