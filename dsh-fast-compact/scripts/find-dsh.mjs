/**
 * Locate the installed dsh CLI entry (`@deepseek-ai/dsh/lib/bin.js`) on any
 * platform, for the helper scripts and tests. Resolution order:
 *   1. the DSH_ENTRY environment variable;
 *   2. the `dsh` command on PATH (following npm/pnpm shims to the real file);
 *   3. the global npm root.
 * Returns undefined when dsh cannot be found.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

function binFromPackageRoot(root) {
  const entry = join(root, 'lib', 'bin.js');
  return existsSync(entry) ? realpathSync(entry) : undefined;
}

function run(command, args) {
  const shell = process.platform === 'win32'; // Windows needs cmd.exe for `where` and the npm shim
  try {
    // DEP0190 fires when an args ARRAY is handed to a shell-spawned child (the shell
    // only concatenates it, it does not escape it). The probe commands here are fixed
    // literals with no caller input, so on Windows they cross as one joined string and
    // the args array stays empty — same command, no deprecation warning.
    return execFileSync(shell ? [command, ...args].join(' ') : command,
      shell ? [] : args,
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: shell }).trim();
  } catch {
    return '';
  }
}

/** Walk up from a file to the `@deepseek-ai/dsh` package root. */
function packageRootOf(file) {
  let dir = dirname(file);
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      if (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@deepseek-ai/dsh') return dir;
    } catch {
      /* keep walking */
    }
    dir = dirname(dir);
  }
  return undefined;
}

export function findDsh() {
  if (process.env.DSH_ENTRY) return existsSync(process.env.DSH_ENTRY) ? realpathSync(process.env.DSH_ENTRY) : undefined;
  const onPath = process.platform === 'win32' ? run('where', ['dsh']).split(/\r?\n/)[0] : run('sh', ['-c', 'command -v dsh']);
  if (onPath) {
    try {
      const root = packageRootOf(realpathSync(onPath));
      if (root) return binFromPackageRoot(root);
    } catch {
      /* fall through */
    }
    // npm's Windows shims are wrappers next to node_modules.
    const beside = join(dirname(onPath), 'node_modules', '@deepseek-ai', 'dsh');
    if (existsSync(beside)) return binFromPackageRoot(beside);
  }
  const globalRoot = run('npm', ['root', '-g']);
  if (globalRoot) {
    const root = join(globalRoot, '@deepseek-ai', 'dsh');
    if (existsSync(root)) return binFromPackageRoot(root);
  }
  return undefined;
}
