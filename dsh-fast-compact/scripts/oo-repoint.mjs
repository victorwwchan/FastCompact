/**
 * scripts/oo-repoint.mjs — mechanical call-site codemod for the OO refactor.
 *
 * The lib surface moved from module-level functions to one class per file
 * (Measure Messages Pins Config References Recall Compiler Engine Tools Runtime).
 * Exported CONSTANTS keep their old module-level names, so only function
 * references need repointing. This script does exactly that, in two steps per
 * file it is given:
 *   1. rewrite `import { ... } from '<lib>.mjs'` statements — function names
 *      collapse into the class name, constant names stay untouched;
 *   2. prefix every remaining bare call site (`clipText(` -> `Measure.clipText(`),
 *      never touching an already-prefixed `Class.name(` or a member access `.name(`.
 * It changes no logic: same expressions, one extra receiver.
 *
 * Usage (from dsh-fast-compact\):  node scripts/oo-repoint.mjs <file> [<file> ...]
 */

const CLASS_OF = {
  Measure: ['utf8Bytes', 'formatKb', 'oneLine', 'clipText', 'quoted'],
  Messages: ['toolResultsOf', 'toolResultOfEvent', 'isCheckpointSource'],
  Pins: ['pin', 'pinsFor', 'releasePins'],
  Config: ['splitRowConfig', 'deriveRoutePressure', 'deriveHeadroomTokens', 'applyDerivedHeadroom', 'resolveFastCompactConfig'],
  References: ['buildReferenceLines'],
  Recall: ['recall', 'search', 'normalizeRecallRequest', 'renderEvent', 'findOriginalResult'],
  Compiler: ['contextBlocks', 'carriedContext', 'userMessages', 'humanTurns', 'pinnedBlock', 'toolTraffic', 'stateBlock', 'thoughtBlock', 'debugBlock', 'shadowedCallEntries', 'shadowedHumanEntries', 'carriedReferences', 'referenceBlock', 'groupInt', 'shareOf', 'contextStatsBlock', 'buildCheckpoint'],
  Engine: ['createEngineClass', 'locateRegion'],
  Tools: ['recallCallLabel', 'defineRecallTools', 'parseRecallCommand', 'statusText', 'registerCommands'],
  Runtime: ['compareVersions', 'classifyVersion', 'loadRuntime'],
};

const CLASS_OF_NAME = {};
for (const [cls, names] of Object.entries(CLASS_OF)) {
  for (const name of names) CLASS_OF_NAME[name] = cls;
}

import fs from 'node:fs';

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('oo-repoint: pass at least one file');
  process.exit(1);
}

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  let out = source;

  // Step 1: import statements that pull function names out of a lib module.
  out = out.replace(/import\s*\{([^}]*)\}\s*from\s*'([^']*\.mjs)'/g, (match, names, path) => {
    const parts = names.split(',').map((part) => part.trim()).filter(Boolean);
    if (!parts.some((part) => CLASS_OF_NAME[part])) return match;
    const kept = [];
    const classes = new Set();
    for (const part of parts) {
      const cls = CLASS_OF_NAME[part];
      if (cls) classes.add(cls);
      else kept.push(part);
    }
    const merged = [...classes, ...kept];
    return `import { ${merged.join(', ')} } from '${path}'`;
  });

  // Step 2: prefix bare call sites for names whose class is now the receiver.
  for (const [name, cls] of Object.entries(CLASS_OF_NAME)) {
    out = out.replace(new RegExp(`(^|[^.\\w$])(?<!\\bstatic )${name}\\s*\\(`, 'gm'), `$1${cls}.${name}(`);
    // Spread sites (`...name(`) sit behind dots and the guard above skips them.
    out = out.replace(new RegExp(`(\\.\\.\\.)${name}\\s*\\(`, 'gm'), `$1${cls}.${name}(`);
  }

  if (out === source) {
    console.log(`${file}: no change`);
    continue;
  }
  fs.writeFileSync(file, out, 'utf8');
  console.log(`${file}: repointed`);
}
