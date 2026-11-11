/**
 * Reproduction of the live complaint, pinned as a regression test:
 *
 *   "i set thresholdRatio: 0.8, but it runs the compaction at 28%, and it keeps
 *    compacting after every agent response"
 *
 * What the row MEANS under this plugin: compaction may only become possible once
 * the conversation MESSAGES have grown to `thresholdRatio` of the route's raw
 * context window W — one comparison, `surfaceTokens >= ceil(W * ratio)`, with no
 * output reservation and no headroom in it. What the base actually compares is
 * `tokenMeter.measure(session).totalTokens` against its own threshold
 * (compaction-basic/lib/index.js:941), and the real meter prices the WHOLE request
 * envelope, whose tool-schema part is NOT a surface node (`estimateToolsTokens(header)`,
 * dsh-token-meter/lib/index.js:83): with no reusable provider-usage anchor,
 * `totalTokens = toolsTokens + surfaceTokens` (same file, line 753). Tool schemas
 * therefore consume budget before a single message token is counted, and on a small
 * window that shortfall is large enough to make compaction fire long below the
 * configured share — and fire again on every step, because our deterministic
 * checkpoint plus the retained tail keep the post-compaction surface right at the
 * same gate.
 *
 * The fixture sizes its tool schemas like the live session's header (measured
 * 2026-10-30 from this workspace's newest durable log: 7,661 tokens of tool
 * schemas), and uses a route reservation that leaves the row's share REACHABLE:
 * contextWindow 65,535 with an adapter output default of 8,192, so messages can
 * climb to 54,722 tokens = 83.5% of the window and the row's `thresholdRatio: 0.8`
 * is a real gate at ceil(65,535 x 0.8) = 52,428 message tokens (80.0% of W). On the
 * live strata-llm/64KB route that reserves 32,000 for the reply, the same 0.8 share
 * sits past what messages can hold (33,535 tokens = 51.2% of W), so the gate clamps
 * to that route's reachable ceiling and pressure fires at the last reachable step —
 * `engine.mjs` reports the clamp (`clampedToCeiling`, plus `beyondBudget` for the
 * stronger fact), it never silently moves the share elsewhere. engine.test.mjs pins
 * that clamped case; this file pins the arming-when-reachable case at 80%.
 *
 * History of the defect, measured 2026-10-30 against this fixture before the fix:
 * pressure armed at turn 6 with only 19,474 message tokens = 29.7% of the window
 * (the reported ~28%), and 6 of the following steps compacted while their messages
 * were still under the gate. `FastCompactEngine.compactIfNeeded` now enforces the
 * gate it derived against the MESSAGE surface (`measurement.surfaceTokens`) read off
 * the meter's own surface-only projection, so these two tests pin the corrected
 * behavior: arming only once the messages reach ceil(W × ratio), and no step
 * compacting while they sit under it.
 *
 * Skipped when dsh is not installed (needs the real base engine and meter math).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { findDsh } from '../scripts/find-dsh.mjs';
import { Runtime } from '../lib/runtime.mjs';
import { Engine } from '../lib/engine.mjs';
import { Config } from '../lib/config.mjs';
import { buildEvents } from './helpers.mjs';

const entry = findDsh();
const skip = entry === undefined ? 'dsh is not installed' : false;

// The preset's tight-route share (its commented modelPolicies carry thresholdRatio: 0.8 for
// strata-llm/64KB; the top-level default is 0.7) put on a route whose reply reservation leaves
// that share REACHABLE, so this file can pin arming exactly AT 80% of the window. On the live
// 64KB route (O=32,000) that same share clamps to 30,914 = 47.2%, and engine.test.mjs pins that
// clamp instead.
const WINDOW = 65_535;
const OUTPUT_RESERVED = 8_192;
const ROW = { thresholdRatio: 0.8, retainRatio: 0.12, compactionRetries: 1, auto: true };

async function harness() {
  if (harness.loaded === undefined) {
    const runtime = await Runtime.loadRuntime(entry, { allowUntested: true });
    const require = createRequire(entry);
    const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
    const { TokenMeter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter')).href);
    harness.loaded = {
      Session,
      estimate: TokenMeter.prototype.estimateMessage,
      Engine: Engine.createEngineClass(runtime),
    };
  }
  return harness.loaded;
}

/** The live header's tool list, big enough to match the measured 7,661 tokens. */
function liveTools(count = 24) {
  const tools = [];
  for (let i = 0; i < count; i += 1) {
    tools.push({
      name: `tool_${i}`,
      // Sized so the whole array stringifies to about the live header's length;
      // real harness schemas carry multi-paragraph descriptions and enums, which
      // is why this overhead is kilotokens and not tens.
      description: 'A tool with a description about the size of the ones the live harness ships, enough characters to matter, padded out with the kind of usage notes and parameter guidance a real schema entry carries around for callers to read at every request.'.padEnd(1100, '.'),
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' }, mode: { type: 'string' } }, required: ['path'] },
    });
  }
  return tools;
}

/** Tool-schema tokens the real meter would price off this array (estimateToolsTokens). */
function toolsTokens(tools) {
  return Math.ceil(JSON.stringify(tools).length / 4) + 4;
}

/**
 * The meter the base sees, following dsh-token-meter/lib/index.js exactly for a
 * session with no reusable provider-usage anchor and no image pricing:
 * `surfaceTokens` is the route-priced surface and `totalTokens` adds the envelope's
 * tool schemas on top (lines 753/761). Kept separate from lib/engine.mjs' test
 * stub on purpose - that one sets totalTokens = surfaceTokens, which hides exactly
 * the overhead this repro is about.
 */
function liveMeter(session, estimate, tools) {
  const toolsTokens = Math.ceil(JSON.stringify(tools).length / 4) + 4; // estimateToolsTokens
  const price = (seq) => {
    const derived = session.deriveEventMessage(session.eventAt(seq));
    return derived === null ? 0 : estimate(derived);
  };
  return {
    toolsTokens,
    measure: () => {
      const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: price(seq), heuristicTokens: price(seq) }));
      const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
      return { totalTokens: toolsTokens + surfaceTokens, surfaceTokens, nodes };
    },
    estimateMessage: (message) => (message === null ? 0 : estimate(message)),
  };
}

/** Mount one session/engine pair the way index.mjs mounts a row. */
async function setup(turns, tools) {
  const { Session, estimate, Engine } = await harness();
  const events = buildEvents({ turns, callsPerTurn: 3, resultChars: 4000 });
  // helpers.mjs appends its own request/header; the live envelope's tools must be
  // the ones under test, so replace it in place (same seq, same type).
  events.at(-1).data.header.tools = tools;
  // Automatic ("pressure") compaction only runs inside an OPEN turn — the live
  // agent is always mid-turn when the step boundary asks for it, and the base
  // refuses otherwise (compaction-basic/lib/index.js:460 "no open turn"). The
  // fixture's turns are all closed, so open a tail turn here.
  const last = events.at(-1);
  events.push({ type: 'turn/start', seq: events.length, time: last.time + 1, data: { turn: (last.data?.turn ?? turns) + 1 } });
  const session = Session.create('pressure-repro', events);
  const logs = [];
  const pressureTable = Config.deriveRoutePressure(WINDOW, ROW.thresholdRatio, OUTPUT_RESERVED);
  const perRoute = {
    provider: 'p', model: 'm', contextWindow: WINDOW, defaultMaxTokens: OUTPUT_RESERVED,
    headroomTokens: pressureTable.headroomTokens, thresholdRatio: pressureTable.thresholdRatio,
  };
  const engineConfig = { ...ROW, derivedHeadroom: { topLevel: pressureTable.headroomTokens, topLevelThresholdRatio: pressureTable.thresholdRatio, perRoute: [perRoute] } };
  const meter = liveMeter(session, estimate, tools);
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
    on: () => {},
    get: () => undefined, // no toolResultPruner: nothing may ask a model
    llm: { resolveModelInfo: async (provider, model) => ({ context: { contextWindow: WINDOW }, defaultMaxTokens: OUTPUT_RESERVED }) },
    reflect: { provide: () => {} },
    tokenMeter: meter,
    sessions: { flush: async () => {} },
    waterfall: () => false,
  };
  const engine = new Engine(ctx, engineConfig);
  const agent = { session, runMaintenance: (job) => job(new AbortController().signal) };
  return { session, engine, agent, logs, meter, route: pressureTable, events };
}

/** The gate the row means, in message tokens: its share of the raw window. */
function intendedMessageGate(rowRatio) {
  return Math.ceil(WINDOW * rowRatio);
}

/** Grow the conversation until the base's pressure pass decides to compact. */
async function armed(turnMax = 26) {
  const tools = liveTools(24);
  for (let turns = 1; turns <= turnMax; turns += 1) {
    const setupResult = await setup(turns, tools);
    const measurement = setupResult.meter.measure();
    const result = await setupResult.engine.compactIfNeeded(setupResult.agent, 'pressure', new AbortController().signal);
    if (result === null) continue;
    return { setupResult, measurement, result, turn: turns, tools };
  }
  return null;
}

test('pressure basis: the row arms compaction only once its messages reach their own share', { skip }, async () => {
  const tools = liveTools(24);
  const overhead = toolsTokens(tools);
  assert.ok(overhead >= 7_000 && overhead <= 8_000, `fixture tool schemas price ${overhead} tokens, near the live header's 7,661`);

  const armedAt = await armed();
  assert.ok(armedAt !== null, 'pressure compacted within 26 turns at all');

  const budget = WINDOW - OUTPUT_RESERVED;
  const surfaceTokens = armedAt.measurement.surfaceTokens;
  const messageGate = intendedMessageGate(ROW.thresholdRatio);
  console.log(`armed at turn ${armedAt.turn}: tool schemas ${armedAt.measurement.totalTokens - surfaceTokens} tokens; messages ${surfaceTokens} tokens = ${((100 * surfaceTokens / WINDOW).toFixed(1))}% of the ${WINDOW}-token window (the route's message budget is only ${budget}, so pressure can never climb past ${((100 * budget / WINDOW).toFixed(1))}%); the row wants ${messageGate} message tokens (${(100 * ROW.thresholdRatio).toFixed(0)}% of the window)`);
  assert.ok(
    surfaceTokens >= messageGate,
    `the messages alone (${surfaceTokens}) had NOT reached the row's ${ROW.thresholdRatio} of the WINDOW (${messageGate}) when compaction armed`,
  );
});

test('pressure basis: no step of the same traffic compacts while its messages sit under the gate', { skip }, async () => {
  const armedAt = await armed();
  assert.ok(armedAt !== null, 'pressure compacted within 26 turns at all');

  // The row's share is a per-step claim, not a one-off: on EVERY step of ordinary
  // traffic the base may only arm once this session's messages have reached it.
  // The live "it compacts after every response" symptom shows up here as the steps
  // that armed while their surface was still under the gate — the base's envelope
  // basis (tool schemas included) made it arm ~7,700 tokens too early, and the old
  // budget-relative reading put the gate at floor(33,535 x 0.4) = 13,414 message
  // tokens, half of one step's claim below the window share this plugin enforces.
  const tools = liveTools(24);
  const messageGate = intendedMessageGate(ROW.thresholdRatio);
  const misfires = [];
  for (let turns = 1; turns <= armedAt.turn + 3; turns += 1) {
    const setupResult = await setup(turns, tools);
    const surfaceTokens = setupResult.meter.measure().surfaceTokens;
    const fired = await setupResult.engine.compactIfNeeded(setupResult.agent, 'pressure', new AbortController().signal) !== null;
    if (fired !== surfaceTokens >= messageGate) misfires.push({ turn: turns, surfaceTokens, fired });
  }
  console.log(`steps checked ${armedAt.turn + 3}, steps that disagreed with the messages gate: ${misfires.length} (${misfires.map((entry) => `turn ${entry.turn}: ${entry.surfaceTokens} tokens ${entry.fired ? 'fired' : 'held'}`).join('; ')})`);
  assert.ok(
    misfires.length === 0,
    `${misfires.length} step(s) compacted while the messages were under the gate (e.g. turn ${misfires[0]?.turn}: ${misfires[0]?.surfaceTokens} tokens vs ${messageGate}) — the gate was priced on the envelope, not the messages`,
  );
});
