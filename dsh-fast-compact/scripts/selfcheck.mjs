#!/usr/bin/env node
/**
 * dsh-fast-compact self-check.
 *
 * Standalone script (not a test file) that verifies the package against the
 * RUNNING dsh install on this machine:
 *
 *   1. Static layout — entry exports, cordis patch, package metadata, every
 *      lib module present, and our own block headings (the plugin carries no
 *      vendored checkpoint frame: the base's own frame wraps its body).
 *   2. Mount — loads the plugin into a REAL cordis Context from the installed
 *      dsh (with stub tokenMeter/sessions/tools/commands services) and checks
 *      that it provides `ctx.compaction` exactly once, that the engine is
 *      FastCompactEngine — a subclass of the official BasicCompactionEngine —
 *      that the row's content half reached the engine, and that the recall
 *      tools and commands are re-registered.
 *   3. Pass-through — host pressure keys ride to the base untouched.
 *   4. Failure modes — a stale/vendored key name and a bad value for one of
 *      our own keys must reject at mount with a clear message.
 *
 * Exit code 0 = all checks passed. Requires dsh to be installed.
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { findDsh } from './find-dsh.mjs';
import { DEFAULT_DEBUG, DEFAULT_DEBUG_CHARS } from '../lib/config.mjs';

const pkgDir = fileURLToPath(new URL('..', import.meta.url));
let failures = 0;

async function check(label, fn) {
  try {
    await fn();
    console.log(`ok   ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL ${label}`);
    console.error(`     ${err.message.split('\n').join('\n     ')}`);
  }
}

const entry = findDsh();
if (entry === undefined) {
  console.error('selfcheck: dsh is not installed; nothing to check against.');
  process.exit(2);
}

// ---------------------------------------------------------------- static ---

const indexMod = await import(pathToFileURL(join(pkgDir, 'index.mjs')).href);
const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));

await check('static: entry exports name/inject/apply', () => {
  assert.equal(indexMod.name, 'dsh-fast-compact');
  assert.deepEqual(indexMod.inject, ['tokenMeter', 'sessions', 'llm'], 'llm is needed to read each route\'s window at mount');
  assert.equal(typeof indexMod.apply, 'function');
});

await check('static: version gate lives in lib/runtime.mjs (tested + supported)', async () => {
  const runtime = await import(pathToFileURL(join(pkgDir, 'lib', 'runtime.mjs')).href);
  assert.deepEqual([...runtime.TESTED_DSH_VERSIONS], ['0.2.1-rc.2'], 'tested set trimmed to the installed dsh');
  assert.deepEqual(runtime.SUPPORTED_DSH_RANGE, { min: '0.1.5-rc.2', below: '0.3.0' });
  assert.equal(typeof runtime.loadRuntime, 'function');
});

await check('static: package metadata (dsh bundle patch, engine range, no npm deps)', () => {
  assert.equal(pkg.name, 'dsh-fast-compact');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './index.mjs');
  assert.ok(pkg.exports['.'], 'exports "." present');
  assert.deepEqual(Object.keys(pkg.dependencies ?? {}), [], 'harness classes resolve from the running install, not npm');
  assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml');
  assert.equal(pkg.dsh?.engines?.dsh, '>=0.1.5-rc.2 <0.3.0');
});

await check('static: cordis patch is a comment header plus an empty row list', () => {
  const yml = readFileSync(join(pkgDir, 'cordis.patch.yml'), 'utf8');
  const rows = yml.split(/\r?\n/).filter((line) => line.trim() && !/^\s*#/.test(line));
  assert.deepEqual(rows, ['[]'], `unexpected patch rows: ${JSON.stringify(rows)}`);
});

await check('static: lib holds exactly our own modules, no dead duplicates', () => {
  const own = ['compiler', 'config', 'engine', 'measure', 'messages', 'pins', 'recall', 'references', 'runtime', 'tools'];
  assert.deepEqual(readdirSync(join(pkgDir, 'lib')).filter((name) => name.endsWith('.mjs')).map((name) => name.slice(0, -4)).sort(), own, 'lib/ holds exactly our own modules');
  // The vendored generation is gone: no selection module (the base selects the
  // range), no housekeeping/images/stats byte-shaping (the base owns pressure).
  for (const dropped of ['select', 'housekeeping', 'images', 'stats', 'refs', 'surface', 'bytes']) {
    assert.ok(!existsSync(join(pkgDir, 'lib', `${dropped}.mjs`)), `lib/${dropped}.mjs is a vendored leftover`);
  }
});

await check('static: our own block headings, and no vendored checkpoint frame', () => {
  const compiler = readFileSync(join(pkgDir, 'lib', 'compiler.mjs'), 'utf8');
  assert.ok(compiler.includes("'## State of work'"), 'state block heading is ours');
  assert.ok(compiler.includes("'## Session-log instruction'"), 'instruction heading is ours');
  assert.ok(compiler.includes("'## Session-log references (dropped tool traffic)'"), 'reference heading is ours');
  assert.ok(!compiler.includes('fastcompact-checkpoint'), 'no legacy frame tag: the base frames our body with its own <compacted-summary>');
  const engine = readFileSync(join(pkgDir, 'lib', 'engine.mjs'), 'utf8');
  assert.ok(/class FastCompactEngine extends Base/.test(engine), 'the engine subclasses the official base class');
  assert.ok(/async summarize\(input, agent, signal\)/.test(engine), 'summarize is the single hook we replace');
});

// ----------------------------------------------------------------- mount ---

const require = createRequire(entry);
const { Context, Service } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);

async function rootContext({ capacities = null } = {}) {
  const ctx = new Context();
  const registered = new Map();
  const commands = new Map();
  class Stub extends Service {
    constructor(context, name, body) {
      super(context, name);
      Object.assign(this, body);
    }
  }
  ctx.plugin((context) => { new Stub(context, 'tokenMeter', { measure: () => ({ totalTokens: 0 }), estimateMessage: () => 1 }); });
  ctx.plugin((context) => { new Stub(context, 'sessions', { flush: async () => {} }); });
  // The official base asks for `llm` even though this engine never calls it —
  // the whole point is that the checkpoint is deterministic. `index.mjs` does
  // interrogate it once per mount, to read each route's window; with no capacity
  // metadata here, headroom takes its documented fallback.
  ctx.plugin((context) => {
    new Stub(context, 'llm', capacities === null ? {} : {
      listProviders: () => Object.keys(capacities).map((provider) => ({ id: provider })),
      listModels: (provider) => capacities[provider].map((entry) => ({ provider, id: entry.model })),
      resolveModelInfo: (provider, model) => {
        const entry = capacities[provider].find((candidate) => candidate.model === model);
        if (entry === undefined) throw new Error(`selfcheck: unknown model ${model}`);
        return { provider, id: model, name: model, context: { contextWindow: entry.contextWindow }, ...entry.defaultMaxTokens === void 0 ? {} : { defaultMaxTokens: entry.defaultMaxTokens } };
      },
    });
  });
  ctx.plugin((context) => {
    new Stub(context, 'tools', {
      register(definition) {
        if (registered.has(definition.name)) throw new Error(`tool ${definition.name} registered twice`);
        registered.set(definition.name, definition);
        return () => registered.delete(definition.name);
      },
    });
  });
  ctx.plugin((context) => {
    new Stub(context, 'commands', {
      register(definition) {
        if (commands.has(definition.name)) throw new Error(`command ${definition.name} registered twice`);
        commands.set(definition.name, definition);
        return () => commands.delete(definition.name);
      },
    });
  });
  return { ctx, registered, commands };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

await check('mount: provides ctx.compaction once, as FastCompactEngine over the base', async () => {
  const { ctx } = await rootContext();
  const fiber = ctx.plugin(indexMod, { harnessEntry: entry });
  await fiber;
  await settle();
  const compaction = ctx.get('compaction');
  assert.equal(typeof compaction?.compactNow, 'function', 'compactNow provided by the base');
  assert.equal(typeof compaction?.compactIfNeeded, 'function', 'compactIfNeeded provided by the base');
  assert.equal(compaction.constructor.name, 'FastCompactEngine', 'engine is FastCompactEngine');
  assert.equal(compaction.options.refLineFormat, 'thought', 'our content half defaults to the thought shape');
  assert.equal(compaction.options.thoughtChars, 200, 'and a 200-char thought quote');
  await fiber.dispose();
  await settle();
  assert.equal(ctx.get('compaction'), undefined, 'compaction unregistered on dispose');
});

await check('mount: the row\'s content half rides through to the engine', async () => {
  const { ctx } = await rootContext();
  const fiber = ctx.plugin(indexMod, {
    harnessEntry: entry,
    refLineFormat: 'none',
    thoughtChars: 0,
    instructions: '',
  });
  await fiber;
  await settle();
  const options = ctx.get('compaction').options;
  assert.equal(options.refLineFormat, 'none', 'refLineFormat:none reaches the engine');
  assert.equal(options.thoughtChars, 0, 'thoughtChars:0 reaches the engine (pointer-only lines)');
  assert.equal(options.instructions, '', 'instructions:"" stays "" so the block is off, not defaulted');
  await fiber.dispose();
  await settle();
});

await check('mount: the debug trail knobs ride through (default off, on when asked)', async () => {
  const { ctx } = await rootContext();
  const fiber = ctx.plugin(indexMod, { harnessEntry: entry });
  await fiber;
  await settle();
  const options = ctx.get('compaction').options;
  assert.equal(options.debug, false, 'debug defaults off — the default preset pays no cost for failed calls');
  assert.equal(options.debugChars, DEFAULT_DEBUG_CHARS, 'and the documented default clip reaches the engine');
  await fiber.dispose();
  await settle();
  const onFiber = ctx.plugin(indexMod, { harnessEntry: entry, debug: true, debugChars: 80 });
  await onFiber;
  await settle();
  const onOptions = ctx.get('compaction').options;
  assert.equal(onOptions.debug, true, 'debug:true reaches the engine and turns the trail on');
  assert.equal(onOptions.debugChars, 80, 'debugChars:80 reaches the engine and clips each entry');
  await onFiber.dispose();
  await settle();
});

await check('mount: host pressure keys pass through untouched', async () => {
  const { ctx } = await rootContext();
  const fiber = ctx.plugin(indexMod, {
    harnessEntry: entry, auto: true, thresholdRatio: 0.7, retainTokens: 4096,
  });
  await fiber;
  await settle();
  const compaction = ctx.get('compaction');
  assert.ok(compaction.constructor.name === 'FastCompactEngine', 'the mount still succeeded with host keys');
  assert.equal(compaction.options.auto ?? undefined, undefined, 'host keys are not resolved into our content half');
  await fiber.dispose();
  await settle();
});

await check('mount: headroom AND the ratio are derived per route from that route\'s capacity', async () => {
  const { ctx } = await rootContext({
    capacities: {
      'strata-llm': [{ model: '120KB', contextWindow: 122_880, defaultMaxTokens: 32_000 }, { model: '64KB', contextWindow: 65_535, defaultMaxTokens: 32_000 }],
      'llama-cpp': [{ model: '84k', contextWindow: 84_000 }],
    },
  });
  const fiber = ctx.plugin(indexMod, {
    harnessEntry: entry, thresholdRatio: 0.7, retainRatio: 0.12, maxTokens: 8192,
    modelPolicies: [{ provider: 'llama-cpp', model: '84k', retainRatio: 0.2 }],
  });
  await fiber;
  await settle();
  const config = ctx.get('compaction').config;
  // The row's 0.7 is a share of each route's MESSAGE BUDGET, so no shrink race is
  // needed anywhere: the 4% headroom always fits under the 30% the ratio leaves free.
  assert.equal(config.headroomTokens, 2_621, 'row-level headroom derived from the tightest window read');
  // Unlisted routes get the default translated against the tightest window read
  // (65,535; its output default is unknown, so none is reserved): floor(0.7 * W).
  assert.ok(config.thresholdRatio !== undefined && config.thresholdRatio > 0 && config.thresholdRatio <= 1, 'a route ratio is present');
  assert.equal(config.thresholdRatio, Math.floor(65_535 * 0.7) / 65_535, 'default ratio is the translated window-relative form of that gate');
  const policies = config.modelPolicies.map((policy) => ({ ...policy }));
  assert.deepEqual(policies.map((policy) => `${policy.provider}/${policy.model}`).sort(), ['llama-cpp/84k', 'strata-llm/120KB', 'strata-llm/64KB'], 'every readable route got a policy of its own');
  const byRoute = new Map(policies.map((policy) => [`${policy.provider}/${policy.model}`, policy]));
  // Re-run the BASE's own gate formula with each policy pair: it must land on floor((W-O)*0.7),
  // which is what the user means by "compact at 70%" on a route that reserves output.
  const baseGate = (policy, window, output) => Math.floor(Math.min(window * policy.thresholdRatio, window - output - policy.headroomTokens));
  assert.equal(byRoute.get('strata-llm/120KB').headroomTokens, 4_915, 'headroom stays at the honest 4% share (no shrink needed for a budget-relative ratio)');
  assert.equal(baseGate(byRoute.get('strata-llm/120KB'), 122_880, 32_000), Math.floor((122_880 - 32_000) * 0.7), 'gate = 70% of the 90880-token message budget');
  assert.equal(byRoute.get('strata-llm/64KB').headroomTokens, 2_621, 'the tight route keeps its own 4% share');
  assert.equal(baseGate(byRoute.get('strata-llm/64KB'), 65_535, 32_000), Math.floor((65_535 - 32_000) * 0.7), 'and its gate is 70% of ITS 33535-token budget, not 70% of the window');
  assert.equal(baseGate(byRoute.get('llama-cpp/84k'), 84_000, 0), Math.floor(84_000 * 0.7), 'a route with no output default keeps the ratio unchanged');
  assert.equal(byRoute.get('llama-cpp/84k').retainRatio, 0.2, 'the row\'s own policy keys survived the merge');
  assert.ok(!byRoute.get('llama-cpp/84k').hasOwnProperty('contextWindow'), 'capacity facts stay out of the base\'s policy schema');
  await fiber.dispose();
  await settle();
});

await check('mount: no capacity service means the documented fallback, never the base default', async () => {
  const { ctx } = await rootContext();
  const fiber = ctx.plugin(indexMod, { harnessEntry: entry });
  await fiber;
  await settle();
  assert.equal(ctx.get('compaction').config.headroomTokens, 4_096, 'fallback headroom applied');
  await fiber.dispose();
  await settle();
});

await check('mount: re-registers recall tools and commands (preset-swap safe)', async () => {
  const { ctx, registered, commands } = await rootContext();
  const fiber = ctx.plugin(indexMod, { harnessEntry: entry });
  await fiber;
  await settle();
  assert.deepEqual([...registered.keys()].sort(), ['recall', 'recall_search'], 'recall tools registered once');
  assert.deepEqual([...commands.keys()].sort(), ['fastcompact', 'recall'], 'human commands registered once');
  const recall = registered.get('recall');
  assert.equal(recall.parameters.type, 'object');
  assert.ok(recall.parameters.properties.seq, 'recall tool takes a seq parameter');
  await fiber.dispose();
  await settle();
  assert.equal(registered.size, 0, 'tools unregistered on dispose');
  assert.equal(commands.size, 0, 'commands unregistered on dispose');
});

await check('mount: custom tool names are honored and validated', async () => {
  const { ctx, registered } = await rootContext();
  const fiber = ctx.plugin(indexMod, {
    harnessEntry: entry, recallToolName: 'fc_recall', searchToolName: 'fc_search',
  });
  await fiber;
  await settle();
  assert.deepEqual([...registered.keys()].sort(), ['fc_recall', 'fc_search'], 'custom tool names used');
  await fiber.dispose();
  await settle();
  await assert.rejects(
    (async () => {
      const bad = await rootContext();
      const fiber = bad.ctx.plugin(indexMod, { harnessEntry: entry, searchToolName: 'bad name!' });
      await fiber;
      await fiber.dispose();
    })(),
    /searchToolName/,
  );
});

// ------------------------------------------------------------ failure modes ---

await check('mount: a row that still hand-sets headroom fails at mount', async () => {
  const { ctx } = await rootContext();
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, headroomTokens: 4096 })),
    /headroomTokens is not a row key any more/,
  );
  await assert.rejects(
    (async () => {
      const bad = await rootContext();
      const fiber = bad.ctx.plugin(indexMod, { harnessEntry: entry, modelPolicies: [{ provider: 'strata-llm', model: '120KB', headroomTokens: 4096 }] });
      await fiber;
      await fiber.dispose();
    })(),
    /modelPolicies\[0\]\.headroomTokens is not a row key any more/,
  );
});

await check('mount: a stale vendored key fails at mount', async () => {
  const { ctx } = await rootContext();
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, toolRefs: true })),
    /unknown key/,
  );
});

await check('mount: a dropped refLineFormat shape fails at mount', async () => {
  const { ctx } = await rootContext();
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, refLineFormat: 'fold-tool' })),
    /refLineFormat/,
  );
});

await check('mount: a bad value for one of our own keys fails at mount', async () => {
  const { ctx } = await rootContext();
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, thoughtChars: -1 })),
    /thoughtChars/,
  );
});

await check('mount: a non-boolean debug and a negative debugChars fail at mount', async () => {
  const { ctx } = await rootContext();
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, debug: 'yes' })),
    /debug must be a boolean/,
  );
  await assert.rejects(
    Promise.resolve(ctx.plugin(indexMod, { harnessEntry: entry, debugChars: -1 })),
    /debugChars/,
  );
});

console.log(failures === 0 ? 'selfcheck: all checks passed' : `selfcheck: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
