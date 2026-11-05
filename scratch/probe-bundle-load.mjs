// One-off probe: run DSH's own profile-directory loader against the web
// profile and report whether every bundle — especially the two
// dsh-fast-compact packages — resolves without being skipped.
import { loadProfileDirectory } from 'file:///C:/Users/vic/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js';

const dshPkg = 'C:/Users/vic/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/package.json';
const res = loadProfileDirectory('dsh', 'C:/Users/vic/.dsh/profiles/web', dshPkg);

for (const l of res.layers) console.log(`layer  ${l.packageName} -> ${l.packageDir} (patch rows: ${l.patches.length})`);
for (const s of res.skippedBundles) console.log(`SKIP   ${s.packageName}: ${s.reason}`);

const fast = res.layers.filter((l) => l.packageName.startsWith('dsh-fast-compact'));
const ok = fast.map((l) => l.packageName).sort().join(',') === 'dsh-fast-compact,dsh-fast-compact-preset' && res.skippedBundles.length === 0;
console.log(ok ? 'RESULT: both fast-compact bundles loaded, nothing skipped' : `RESULT: FAIL (loaded: ${fast.map((l) => l.packageName)})`);
process.exit(ok ? 0 : 1);
