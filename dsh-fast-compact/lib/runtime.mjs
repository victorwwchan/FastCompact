/**
 * dsh-fast-compact — locate the running dsh harness and load the classes this
 * engine builds on. The engine is a subclass of the OFFICIAL base-compact class
 * (`@deepseek-ai/dsh-compaction-basic`'s `BasicCompactionEngine`), so selection,
 * the durable bracket transaction, pressure policy, retention and shrink
 * validation are the host's own code — this plugin resolves the very class the
 * running install uses (never a second npm copy) and overrides one hook.
 *
 * Harness packages are resolved through the RUNNING dsh install (never a
 * second npm copy), so `CompactionEngine`, the session helpers and the tool
 * registry are the exact classes the host uses.
 *
 * A pinned `TESTED_DSH_VERSIONS` set plus a prerelease-aware supported range
 * decide whether an untested host is accepted; the API contract check then
 * proves the injected classes carry the methods this engine calls, before any
 * session work happens.
 *
 * @module dsh-fast-compact/lib/runtime
 */

import { createRequire } from 'node:module';
import { realpathSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * dsh versions this plugin was tested against (unit, real-harness engine and
 * mount tests, plus a preset mount in a real boot).
 */
export const TESTED_DSH_VERSIONS = Object.freeze(['0.2.1-rc.2']);

/**
 * Versions accepted without `allowUntestedHarness`: from the first release
 * with the compaction seam through the 0.2 series. Untested versions in this
 * range load only if the API contract check passes, with a one-time warning.
 * 0.3.0 and its prereleases are refused until tested.
 */
export const SUPPORTED_DSH_RANGE = Object.freeze({ min: '0.1.5-rc.2', below: '0.3.0' });

/** Compare two semver strings, prerelease aware (`0.1.7-rc.2` < `0.1.7`). */
export function compareVersions(left, right) {
  const parse = (version) => {
    const [core, pre] = String(version).split('-', 2);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), pre: pre === undefined ? null : pre.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    if ((a.core[index] ?? 0) !== (b.core[index] ?? 0)) return (a.core[index] ?? 0) < (b.core[index] ?? 0) ? -1 : 1;
  }
  if (a.pre === null || b.pre === null) return a.pre === b.pre ? 0 : a.pre === null ? 1 : -1;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const x = a.pre[index];
    const y = b.pre[index];
    const nx = /^\d+$/.test(x) ? Number(x) : null;
    const ny = /^\d+$/.test(y) ? Number(y) : null;
    if (x === y) continue;
    if (nx !== null && ny !== null) return nx < ny ? -1 : 1;
    if (nx !== null || ny !== null) return nx !== null ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * How a dsh version is treated.
 * @returns {'tested' | 'compatible' | 'unsupported' | 'unknown'}
 */
export function classifyVersion(version) {
  if (version === undefined) return 'unknown';
  if (TESTED_DSH_VERSIONS.includes(version)) return 'tested';
  // `below` excludes that release's prereleases too (0.3.0-alpha.1 is outside the range).
  const core = String(version).split('-', 1)[0];
  const inRange = compareVersions(version, SUPPORTED_DSH_RANGE.min) >= 0 && compareVersions(core, SUPPORTED_DSH_RANGE.below) < 0;
  return inRange ? 'compatible' : 'unsupported';
}

/** Locate the dsh package root from the running CLI entry. */
function harnessRoot(entry) {
  let dir = dirname(realpathSync(entry));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { dir, version: pkg.version };
    } catch {
      /* keep walking up */
    }
    dir = dirname(dir);
  }
  return undefined;
}

function importFrom(require, specifier) {
  return import(pathToFileURL(require.resolve(specifier)).href);
}

/**
 * Load the harness classes this plugin builds on.
 * @param {string} [harnessEntry] - path of the running dsh CLI (defaults to argv[1]).
 * @param {{ allowUntested?: boolean }} [options]
 */
export async function loadRuntime(harnessEntry = process.argv[1], options = {}) {
  if (!harnessEntry) throw new Error('dsh-fast-compact: cannot locate the running dsh; set harnessEntry');
  const root = harnessRoot(harnessEntry);
  const status = classifyVersion(root?.version);
  if (status === 'unsupported' && options.allowUntested !== true) {
    throw new Error(`dsh-fast-compact: dsh ${root.version} is outside the supported range (>= ${SUPPORTED_DSH_RANGE.min} and < ${SUPPORTED_DSH_RANGE.below}); refusing to load. Set allowUntestedHarness: true to override.`);
  }
  const require = createRequire(realpathSync(harnessEntry));
  const [compaction, basic, llm, tools] = await Promise.all([
    importFrom(require, '@deepseek-ai/dsh-compaction'),
    importFrom(require, '@deepseek-ai/dsh-compaction-basic'),
    importFrom(require, '@deepseek-ai/dsh-llm'),
    importFrom(require, '@deepseek-ai/dsh-tools'),
  ]);
  const runtime = {
    version: root?.version,
    versionStatus: status,
    CompactionEngine: compaction.CompactionEngine,
    BasicCompactionEngine: basic.BasicCompactionEngine,
    ManualCompactionError: compaction.ManualCompactionError,
    CompactionId: compaction.CompactionId,
    compactCheckpointSource: compaction.compactCheckpointSource,
    toolPairingBalancedBefore: compaction.toolPairingBalancedBefore,
    toolPairingBalancedAfter: compaction.toolPairingBalancedAfter,
    createUserMessage: llm.createUserMessage,
    errorChain: llm.errorChain,
    freezeMessage: llm.freezeMessage,
    HarnessError: llm.HarnessError,
    CONTEXT_WINDOW_EXCEEDED_CODE: llm.CONTEXT_WINDOW_EXCEEDED_CODE,
    defineTool: tools.defineTool,
  };
  // Contract check: every export this plugin uses must exist with the right
  // shape, and the official base class must still carry the hook we override
  // plus the protocol methods our subclass depends on. A dsh that renamed or
  // removed any of them is refused, whatever its version says.
  const missing = Object.entries(runtime)
    .filter(([key, value]) => !['version', 'versionStatus'].includes(key) && (key === 'CONTEXT_WINDOW_EXCEEDED_CODE' ? typeof value !== 'string' : typeof value !== 'function'))
    .map(([key]) => key);
  const baseMethods = ['summarize', 'compactIfNeeded', 'compactRegion', 'compactNow', 'regionDependencies'];
  const missingHooks = typeof runtime.BasicCompactionEngine === 'function'
    ? baseMethods.filter((method) => typeof runtime.BasicCompactionEngine.prototype?.[method] !== 'function').map((method) => `BasicCompactionEngine.${method}`)
    : [];
  if (missing.length + missingHooks.length > 0 && options.allowUntested !== true) {
    throw new Error(`dsh-fast-compact: dsh ${root?.version ?? '(unknown)'} lacks ${[...missing, ...missingHooks].join(', ')}; refusing to load (this dsh is not compatible with this plugin version)`);
  }
  return runtime;
}
