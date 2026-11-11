/**
 * Engine tests against the REAL installed harness: a real `Session`, the real
 * `BasicCompactionEngine` contract, and this package's fast-compact subclass.
 *
 * What these tests pin is the subclass boundary. Selection, the durable bracket
 * transaction (`compaction/start` -> `compaction/summary` -> replacement
 * `user/message` -> `compaction/end`), retention, shrink validation and
 * overflow recovery all stay with `@deepseek-ai/dsh-compaction-basic`; our hook
 * only decides WHAT the replacement text says — deterministically, from the
 * session log, with no model request anywhere. The fixture never configures an
 * `llm` service at all, so any base path that tried to ask a model would fail
 * loudly rather than quietly answer.
 *
 * The only harness piece we stub is the token meter: the base needs priced
 * surface nodes and one message estimate (for its shrink rule), and this suite
 * is about content, not pricing. The heuristic estimator comes from the real
 * `TokenMeter` so the fixture stays on the harness's own arithmetic.
 *
 * Skipped when dsh is not installed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { findDsh } from '../scripts/find-dsh.mjs';
import { Runtime } from '../lib/runtime.mjs';
import { Engine, ENGINE_PROVIDER, ENGINE_MODEL } from '../lib/engine.mjs';
import { Compiler, STATS_HEADING } from '../lib/compiler.mjs';
import { Config } from '../lib/config.mjs';
import { Pins } from '../lib/pins.mjs';
import { Recall } from '../lib/recall.mjs';
import { toolResultsOf, buildEvents } from './helpers.mjs';

const entry = findDsh();
const skip = entry === undefined ? 'dsh is not installed' : false;

/** One runtime load shared by every test. */
async function harness() {
  if (harness.loaded === undefined) {
    const runtime = await Runtime.loadRuntime(entry, { allowUntested: true });
    const require = createRequire(entry);
    const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
    const { TokenMeter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter')).href);
    harness.loaded = {
      Session,
      estimate: TokenMeter.prototype.estimateMessage, // standalone heuristic (never uses `this`)
      Engine: Engine.createEngineClass(runtime),
    };
  }
  return harness.loaded;
}

/**
 * The meter the base needs: one priced node per SURFACE node (in surface order —
 * `selectCompactableRange` refuses a meter that disagrees with the session) plus
 * the message estimate behind its shrink rule. Pricing is a plain heuristic, so
 * these tests never depend on real token arithmetic. The real meter also folds the
 * request envelope's tool schemas into `totalTokens` but keeps them OUT of
 * `surfaceTokens` (dsh-token-meter/lib/index.js:753), so the stub takes that
 * overhead as a knob and reports both totals the same way.
 */
function meterFor(session, estimate, toolsTokens = 0) {
  const priced = (seq) => {
    const derived = session.deriveEventMessage(session.eventAt(seq));
    return derived === null ? 0 : estimate(derived);
  };
  return {
    measure: () => {
      const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: priced(seq), heuristicTokens: priced(seq) }));
      const surfaceTokens = nodes.reduce((total, node) => total + node.tokens, 0);
      return { surfaceTokens, totalTokens: toolsTokens + surfaceTokens, nodes };
    },
    estimateMessage: (message) => (message === null ? 0 : estimate(message)),
  };
}

/**
 * Build a fresh session + engine pair over the synthetic fixture.
 * @param {object} config - plugin row config (plus host keys if wanted).
 * @param {object} eventOptions - knobs for the fixture log.
 */
async function fcSetup(config = {}, eventOptions = {}, toolsTokens = 0) {
  const { Session, estimate, Engine } = await harness();
  const events = buildEvents({ format: 'v2', ...eventOptions });
  const session = Session.create('engine-test', events);
  const logs = [];
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
    on: () => {},
    get: () => undefined, // no toolResultPruner: nothing may ask a model here
    llm: { resolveModelInfo: async (provider, model) => ({ context: { contextWindow: 65_535 }, defaultMaxTokens: 32_000 }) },
    reflect: { provide: () => {} },
    tokenMeter: meterFor(session, estimate, toolsTokens),
    sessions: { flush: async () => {} },
    waterfall: () => false,
  };
  const engine = new Engine(ctx, { auto: false, ...config });
  const agent = { session, runMaintenance: (job) => job(new AbortController().signal) };
  return { Session, session, engine, agent, logs, events };
}

/** Rebuild a Session from the log to run the harness's own validation. */
function revalidate(Session, session) {
  return Session.create('revalidate', [...session.snapshotEvents()]);
}

/** Surface messages of the CURRENT surface (log-only events are not on it). */
function surfaceMessages(session) {
  const out = [];
  for (const seq of session.surface.nodes) {
    const derived = session.deriveEventMessage(session.eventAt(seq));
    if (derived !== null) out.push(derived);
  }
  return out;
}

/** Every tool call still on the surface must still own its result, and back. */
function pairing(messages) {
  const calls = new Set();
  const answered = new Set();
  let orphans = 0;
  for (const message of messages) {
    for (const block of message.content ?? []) if (block?.type === 'tool-call') calls.add(block.id);
    for (const result of toolResultsOf(message)) {
      if (!calls.has(result.toolCallId)) orphans += 1;
      answered.add(result.toolCallId);
    }
  }
  return { orphans, unanswered: [...calls].filter((id) => !answered.has(id)).length };
}

/** The replacement checkpoint message the base wrote into the surface. */
function checkpointMessages(session) {
  const out = [];
  for (const node of session.surface.nodes) {
    const event = session.eventAt(node);
    if (event === undefined || event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'compact-checkpoint') continue;
    out.push(event);
  }
  return out;
}

/** Joined text of one message. */
function textOf(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

test('engine: the compiler answers with its own identity and no model call', { skip }, async () => {
  const { session, engine, agent } = await fcSetup();
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const summary = session.eventAt(result.summarySeq).data;
  assert.equal(summary.provider, ENGINE_PROVIDER, 'the plugin owns the provider slot');
  assert.equal(summary.model, ENGINE_MODEL, 'and the model slot — no LLM answered');
  assert.ok(Array.isArray(summary.summary), 'summary is text blocks');
  assert.ok(summary.summary.every((block) => block.type === 'text'), 'text only — the compiler writes prose');
  assert.equal(summary.shadowedSeqs.length, result.shadowedSeqs.length, 'the summary event names the same span');
});

test('engine: the base frames our compiled blocks as its replacement message', { skip }, async () => {
  const { Session, session, engine, agent } = await fcSetup();
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const [checkpoint] = checkpointMessages(session);
  assert.equal(checkpoint.data.source.kind, 'compact-checkpoint', 'the base marked it as ITS checkpoint');
  const text = textOf(checkpoint.data);
  assert.ok(text.includes('<compacted-summary>'), 'the base frame still wraps the summary');
  assert.ok(text.includes('automatically generated checkpoint'), 'and the preamble is the base\'s own words');
  // The blocks are ours, and they survive the framing untouched.
  assert.ok(text.includes('## State of work'), 'our state block survived into the window');
  assert.ok(text.includes('## Session-log references (dropped tool traffic)'), 'the reference section is in the window');
  // The resume instruction no longer rides INSIDE the checkpoint: the mount injects it as
  // its own live copy once per surface generation, so the default body carries no such pair.
  assert.ok(!text.includes('<system prompt>'), 'the default body carries no instruction pair — the mount owns that copy');
  // Determinism: re-compiling the same span right now must reproduce exactly
  // what the base committed — no model, so nothing can have drifted.
  const { text: again } = Compiler.buildCheckpoint(session, result.shadowedRange.start, result.shadowedRange.end, {});
  assert.ok(text.includes(again), 'the committed body is byte-for-byte our compiler\'s own output');
  revalidate(Session, session);
});

test('engine: a row-named instruction rides OUTSIDE the summary in its own pair', { skip }, async () => {
  const sentinel = 'Sentinel rule: lead every reply with fresh state.';
  const { Session, session, engine, agent } = await fcSetup({ instructions: sentinel });
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const [checkpoint] = checkpointMessages(session);
  const text = textOf(checkpoint.data);
  // The base closes its own summary frame before the instruction pair opens, then reopens
  // a second summary frame for the carried body — every tag stays balanced.
  assert.ok(text.includes('</compacted-summary>\n\n<system prompt>\n' + sentinel + '\n</system prompt>\n\n<compacted-summary>'),
    'the instruction sits outside both summary frames, in its own pair, ahead of the body');
  assert.equal((text.match(/<compacted-summary>/g) ?? []).length, 2, 'the summary frame is split, not doubled by accident');
  assert.equal((text.match(/<\/compacted-summary>/g) ?? []).length, 2, 'and every open tag has its close tag');
  revalidate(Session, session);
});

test('engine: every seq the references name is restorable through recall', { skip }, async () => {
  const { session, engine, agent } = await fcSetup();
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const [checkpoint] = checkpointMessages(session);
  const text = textOf(checkpoint.data);
  const referenced = [...text.matchAll(/result seq (\d+)/g)].map((match) => Number(match[1]));
  assert.ok(referenced.length > 0, 'the section names result seqs');
  for (const seq of referenced.slice(0, 5)) {
    const restored = Recall.recall(session, { result: seq }, { maxChars: 4_000 });
    assert.ok(restored.events >= 1, `seq ${seq} resolves to something`);
    assert.ok(restored.text.includes('RESULT-'), 'the ORIGINAL result text comes back, not a paraphrase');
    assert.ok(result.shadowedSeqs.includes(seq), `seq ${seq} was shadowed and is still in the log`);
  }
});

test('engine: the compacted span is gone and its traffic stays paired', { skip }, async () => {
  const { session, engine, agent } = await fcSetup();
  const beforeNodes = session.surface.nodes.length;
  const beforePairing = pairing(surfaceMessages(session));
  assert.deepEqual(beforePairing, { orphans: 0, unanswered: 0 }, 'the fixture starts well paired');
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  assert.ok(result.shadowedSeqs.length > 0, 'a real span was shadowed');
  assert.ok(session.surface.nodes.length < beforeNodes, `the surface shrank from ${beforeNodes} node(s)`);
  const after = pairing(surfaceMessages(session));
  assert.deepEqual(after, { orphans: 0, unanswered: 0 }, 'no call lost its result and no result is orphaned');
  // The shadowed traffic is off the surface but still in the log.
  for (const seq of result.shadowedSeqs.slice(0, 5)) {
    assert.ok(!session.surface.nodes.includes(seq), `seq ${seq} left the surface`);
    assert.notEqual(session.eventAt(seq), undefined, 'and is still readable from the log');
  }
});

test('engine: the plugin records exactly the span the base shadowed', { skip }, async () => {
  const { session, engine, agent } = await fcSetup({ thoughtChars: 120, refLineFormat: 'none' });
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const record = engine.lastCompaction(session);
  assert.ok(record !== undefined, 'the plugin remembered the compaction for /fastcompact');
  assert.equal(record.start, result.shadowedRange.start, 'same first seq as the base committed');
  assert.equal(record.end, result.shadowedRange.end, 'same last seq — locateRegion found the base\'s span');
  assert.ok(record.stats.refs > 0, 'reference lines were emitted for the dropped traffic');
  const [checkpoint] = checkpointMessages(session);
  const text = textOf(checkpoint.data);
  assert.ok(!text.includes('(thought seq'), 'refLineFormat none: no line names a thought');
  assert.ok(/- \w+ .+ → seq \d+, result seq \d+/.test(text), 'lines are labelled by the tool itself');
});

test('engine: a runtime shape override changes only what it selects', { skip }, async () => {
  const { session, engine, agent } = await fcSetup({ thoughtChars: 200, refLineFormat: 'thought' });
  assert.deepEqual(engine.currentShape(session), { refLineFormat: 'thought', thoughtChars: 200 }, 'preset shape at rest');
  engine.setShape(session, { refLineFormat: 'none', thoughtChars: 0 });
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const [checkpoint] = checkpointMessages(session);
  const text = textOf(checkpoint.data);
  assert.ok(!text.includes('(thought seq'), 'override applied: no thought pointer anywhere in the body');
  assert.ok(text.includes('last agent thought not quoted; resume from its own words'),
    'thoughtChars 0 keeps the pointer line instead of quoting the thought');
  // Clearing it resumes the configured preset — the override is per-session, not global.
  engine.setShape(session, { refLineFormat: null, thoughtChars: null });
  assert.deepEqual(engine.currentShape(session), { refLineFormat: 'thought', thoughtChars: 200 }, 'preset shape restored');
});

test('engine: a recalled seq is pinned into the checkpoint, then released', { skip }, async () => {
  const { Session, session, engine, agent } = await fcSetup();
  // A seq the model would have pulled back: pin it BEFORE compacting so the
  // checkpoint must carry its words verbatim.
  const target = session.surface.nodes.find((seq) => {
    const event = session.eventAt(seq);
    return event.type === 'user/message' && event.data?.source?.kind === 'user';
  });
  assert.ok(target !== undefined, 'the fixture has a human message to pin');
  Pins.pin(session, [target]);
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  if (result.shadowedSeqs.includes(target)) {
    const [checkpoint] = checkpointMessages(session);
    const text = textOf(checkpoint.data);
    assert.ok(text.includes(`[pinned seq ${target}]`), 'the pinned entry was carried verbatim');
    assert.ok(text.includes('## Pinned content (every user message kept'), 'under its own heading');
  }
  // The checkpoint now holds it, so a later compaction must not repeat it.
  assert.deepEqual([...Pins.pinsFor(session)].filter((seq) => result.shadowedSeqs.includes(seq)), [], 'the pins the span honored were released');
  revalidate(Session, session);
});

test('engine: the debug knob prices the window and states what actually gated', { skip }, async () => {
  const routePressure = Config.deriveRoutePressure(65_535, 0.9, 32_000);
  const { Session, session, engine, agent } = await fcSetup({
    debug: true,
    derivedHeadroom: {
      topLevel: null,
      topLevelThresholdRatio: null,
      perRoute: [{ provider: 'p', model: 'm', contextWindow: 65_535, defaultMaxTokens: 32_000, ...routePressure }],
    },
  });
  const header = session.requestHeader()?.config;
  assert.deepEqual({ provider: 'p', model: 'm' }, { provider: header.provider, model: header.model }, 'the fixture routes at p/m');
  const { estimate } = await harness();
  // What the meter prices before anything is shadowed: the surface, node by node.
  const priced = (seq) => {
    const derived = session.deriveEventMessage(session.eventAt(seq));
    return derived === null ? 0 : estimate(derived);
  };
  const surfaceBefore = [...session.surface.nodes];
  const expectedBefore = surfaceBefore.reduce((total, seq) => total + priced(seq), 0);
  // The dump check counts what `debug/` already holds BEFORE this run.
  const dumpDir = resolve('debug');
  let existingDumps = new Set();
  try {
    existingDumps = new Set(await readdir(dumpDir));
  } catch {}
  const result = await engine.compactNow(agent, new AbortController().signal);
  assert.ok(result !== null, 'compaction ran');
  const record = engine.lastCompaction(session);
  const stats = record.stats.contextStats;
  assert.ok(stats !== null, 'the accounting was measured (a meter is mounted)');

  // Recompute the meter's own sums for the span: the block must report the SAME
  // numbers the base priced, not an approximation of its own.
  const expectedShadowed = result.shadowedSeqs.reduce((total, seq) => total + priced(seq), 0);
  assert.equal(stats.shadowedTokens, expectedShadowed, 'shadowed tokens are the meter\'s own per-node prices');
  assert.equal(stats.beforeTokens, expectedBefore, 'the before figure is the surface as priced, node for node');

  // The gate the plugin enforces: the row's share of the WINDOW, clamped to what the
  // messages can hold once the reply is reserved — 90% of 65,535 on this route sits
  // past its message budget, so pressure fires at the last reachable step instead.
  const entry = engine.pressureTable.perRoute[0];
  assert.equal(entry.headroomTokens, Config.deriveRoutePressure(65_535, 0.9, 32_000).headroomTokens, 'the route\'s derived headroom');
  assert.equal(stats.outputReserved, 32_000, 'and its reserved output come from the adapter, not the row');
  assert.equal(stats.messageBudget, 33_535, 'the usable message budget of that route');
  assert.equal(stats.requestedGateTokens, Math.ceil(65_535 * 0.9), 'the raw 90% share of the WINDOW, reported untouched');
  assert.equal(stats.gateTokens, 30_914, 'clamped to the 33,535-token budget minus its 2,621-token headroom: pressure fires at the last reachable step');
  assert.ok(stats.clampedToCeiling === true, 'and the clamp is visible in the stats, not hidden');
  assert.equal(stats.beyondBudget, true, 'that share sits past the 33,535-token message budget: pressure here runs on borrowed time');
  assert.ok(stats.route === 'p/m', 'the block names the route that gated this compaction');

  // Internal consistency of the accounting line itself.
  assert.equal(stats.afterTokens, stats.beforeTokens - stats.shadowedTokens + stats.checkpointTokens, 'after = before - shadowed + checkpoint');
  assert.equal(stats.freedTokens, stats.beforeTokens - stats.afterTokens, 'freed = what actually left the window');

  const [checkpoint] = checkpointMessages(session);
  const text = textOf(checkpoint.data);
  assert.ok(text.includes(STATS_HEADING), 'the checkpoint carries the window-accounting block');
  assert.ok(text.includes('usage before compact:') && text.includes('after compact:'), 'the one-line block reports usage before and after compaction');
  const gateShare = `${((stats.gateTokens / stats.contextWindow) * 100).toFixed(1)}%`;
  assert.ok(text.includes(`gate ${gateShare}`), 'and the gate that governs the next compaction, as a share of the window');
  assert.ok(text.includes(`- debug dump: ${stats.debugDumpPath}`), 'the block names where its on-disk copy lives');

  // `debug` also leaves our compiled window on disk: one file in debug/ under the
  // process working directory, named from the session id and shadowed range. The
  // dump holds ONLY what our compiler emitted — the base adds its preamble
  // upstream (and lands its trailing close tag on our reopened pair), so the
  // framed message and the dump differ by exactly that wrapper.
  assert.ok(typeof stats.debugDumpPath === 'string' && stats.debugDumpPath.length > 0, 'the accounting names the dump file');
  assert.ok(stats.debugDumpPath.startsWith(`${dumpDir}${sep}`), 'in debug/ under the working directory');
  const dumped = await readFile(stats.debugDumpPath, 'utf8');
  const compiled = session.eventAt(result.summarySeq).data.summary;
  assert.ok(Array.isArray(compiled) && compiled.length === 1 && typeof compiled[0]?.text === 'string', 'the summary event names what our compiler emitted');
  assert.equal(dumped, compiled[0].text, 'and it holds EXACTLY that compiled body, stats block included');
  assert.ok(text.includes(compiled[0].text), 'and the session message carries that same body inside the upstream frame');
  assert.ok(!dumped.includes('automatically generated checkpoint'), 'no upstream preamble in the dump — the base frame stays upstream of our split tags');
  const freshDumps = (await readdir(dumpDir)).filter((name) => !existingDumps.has(name));
  assert.equal(freshDumps.length, 1, 'exactly one new file for this compaction');
  assert.match(freshDumps[0], /^session-engine-test-\d+-seq\d+-\d+\.txt$/, 'named from the session id and seq range');

  revalidate(Session, session);

  // debug off: no block anywhere, nothing recorded for the command, and NO dump.
  const plain = await fcSetup();
  const plainResult = await plain.engine.compactNow(plain.agent, new AbortController().signal);
  assert.ok(plainResult !== null, 'compaction ran without the knob');
  assert.equal(plain.engine.lastCompaction(plain.session).stats.contextStats, null, 'debug off records no accounting');
  const [plainCheckpoint] = checkpointMessages(plain.session);
  assert.ok(!textOf(plainCheckpoint.data).includes(STATS_HEADING), 'and prints none');
  assert.ok(!textOf(plainCheckpoint.data).includes('debug dump'), 'nor a debug-dump line — nothing if the knob is off');
  const afterPlain = (await readdir(dumpDir)).filter((name) => !existingDumps.has(name));
  assert.deepEqual(afterPlain, freshDumps, 'and writes no dump file');
  revalidate(Session, plain.session);
});

test('engine: the pressure gate governs the MESSAGES, not the envelope of tool schemas', { skip }, async () => {
  const routePressure = Config.deriveRoutePressure(65_535, 0.9, 32_000);
  // Our gate is the row's share of the WINDOW (58,982 on W=65,535), read against the
  // meter's surface-only reading. The base instead decides on its own envelope
  // threshold — the same share capped at the message budget minus the derived margin
  // (33,535 - 2,621 = 30,914 here) — so a fixture whose MESSAGES sit between those two
  // numbers is exactly where the base alone would compact and this plugin must not.
  const ourGate = Math.ceil(65_535 * 0.9);
  const baseGate = 33_535 - routePressure.headroomTokens;
  assert.ok(ourGate > baseGate, 'the window share sits past what the envelope threshold can reach');
  const toolsTokens = 16_000; // the fixture's messages alone sit under our gate; with schemas the envelope passes the base's
  const mounted = await fcSetup({
    thresholdRatio: 0.9,
    retainRatio: 0.12,
    maxTokens: 8192,
    auto: true,
    compactionRetries: 1,
    derivedHeadroom: {
      topLevel: routePressure.headroomTokens,
      topLevelThresholdRatio: routePressure.thresholdRatio,
      perRoute: [{ provider: 'p', model: 'm', contextWindow: 65_535, defaultMaxTokens: 32_000, ...routePressure }],
    },
  }, {}, toolsTokens);
  const measurement = mounted.engine.ctx.tokenMeter.measure();
  assert.ok(measurement.totalTokens >= baseGate, 'the envelope alone is over the base\'s own threshold, so the base alone would compact here');
  assert.ok(measurement.surfaceTokens < ourGate, 'while the messages still sit under the row\'s share of the window');
  const result = await mounted.engine.compactIfNeeded(mounted.agent, 'pressure', new AbortController().signal);
  assert.equal(result, null, 'and nothing compacted: the row\'s share governs the MESSAGES');
});

test('engine: a route the mount table never named still gets its real gate', { skip }, async () => {
  const routePressure = Config.deriveRoutePressure(65_535, 0.9, 32_000);
  // perRoute EMPTY: the profile's capacities were not readable while the plugin
  // mounted (the web GUI loads providers after mounting), so nothing could name a
  // gate at mount. learnRoute reads the window straight from the session — the
  // requestContext() the meter prices against — at compaction time instead, and the
  // row's share of THAT window gates the messages, untouched by any reservation.
  const ourGate = Math.ceil(65_535 * 0.9);
  const baseGate = 33_535 - routePressure.headroomTokens;
  const mounted = await fcSetup({
    thresholdRatio: 0.9,
    retainRatio: 0.12,
    maxTokens: 8192,
    auto: true,
    compactionRetries: 1,
    derivedHeadroom: {
      topLevel: routePressure.headroomTokens,
      topLevelThresholdRatio: routePressure.thresholdRatio,
      perRoute: [],
    },
  }, {}, 12_000);
  const measurement = mounted.engine.ctx.tokenMeter.measure();
  assert.ok(measurement.totalTokens >= baseGate, 'the envelope alone is over the base\'s own threshold');
  assert.ok(measurement.surfaceTokens < ourGate, 'while the messages still sit under the row\'s share of the window');
  const result = await mounted.engine.compactIfNeeded(mounted.agent, 'pressure', new AbortController().signal);
  assert.equal(result, null, 'the gate was learned at compaction time, so nothing compacted');
  const learned = [...mounted.engine.routeGates.values()];
  assert.equal(learned.length, 1, 'one route learned through ctx.llm on demand');
  assert.ok(learned[0].route === 'p/m', 'named from the session request header');
  assert.equal(learned[0].contextWindow, 65_535, 'capacity read from the adapter metadata');
  assert.equal(learned[0].gateTokens, routePressure.gateTokens, 'the row\'s share of the WINDOW, clamped to what its messages can hold');
  assert.equal(learned[0].requestedGateTokens, Math.ceil(65_535 * 0.9), 'the raw share is carried beside it, untouched');
  assert.ok(learned[0].clampedToCeiling === true, 'and the clamp that moved it is visible on the learned gate');
  assert.equal(learned[0].beyondBudget, true, 'that share sits past the message budget, so pressure here runs on borrowed time');
});
