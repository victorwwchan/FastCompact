// ctxgrep.mjs — print narrow windows around keyword hits in minified JS bundles.
// Usage: node scripts/ctxgrep.mjs --root <dir|file> [...] --pat <regex> [--ctx 140] [--max 40] [--glob \.m?js$]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opts = { roots: [], pats: [], ctx: 140, max: 40, glob: /\.m?js$/ };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--root') opts.roots.push(argv[++i]);
  else if (a === '--pat') opts.pats.push(new RegExp(argv[++i], 'i'));
  else if (a === '--ctx') opts.ctx = Number(argv[++i]);
  else if (a === '--max') opts.max = Number(argv[++i]);
  else if (a === '--glob') opts.glob = new RegExp(argv[++i]);
}
if (!opts.roots.length || !opts.pats.length) { console.error('need --root and --pat'); process.exit(2); }

const files = [];
for (const root of opts.roots) {
  const st = fs.lstatSync(root, { throwErr: false });
  if (!st) { console.log(`!! missing root: ${root}`); continue; }
  if (root.endsWith('.js') || root.endsWith('.mjs')) { files.push(root); continue; }
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const e of fs.readdirSync(dir)) {
      const p = path.join(dir, e);
      if (fs.lstatSync(p, { throwErr: false })?.isDirectory()) stack.push(p);
      else if (opts.glob.test(p)) files.push(p);
    }
  }
}

let hits = 0;
for (const f of files) {
  const text = fs.readFileSync(f, 'utf8');
  const found = [];
  for (const pat of opts.pats) {
    const re = new RegExp(pat.source, 'gi');
    let m;
    while ((m = re.exec(text)) && found.length < opts.max * 4) found.push([m.index, m[0], pat]);
  }
  if (!found.length) continue;
  // merge overlapping windows per file
  found.sort((a, b) => a[0] - b[0]);
  const windows = [];
  for (const [idx, tok, pat] of found) {
    const s = Math.max(0, idx - opts.ctx), e = Math.min(text.length, idx + tok.length + opts.ctx);
    if (windows.length && s <= windows.at(-1).e) { windows.at(-1).e = Math.max(windows.at(-1).e, e); continue; }
    windows.push({ s, e });
  }
  for (const w of windows.slice(0, opts.max)) {
    hits++;
    console.log(`--- ${path.basename(path.dirname(path.dirname(f)))}/${path.basename(f)} @${w.s}`);
    console.log(text.slice(w.s, w.e).replace(/\n/g, ' \\n '));
    if (hits >= opts.max) { console.log(`(stopped at ${opts.max} windows)`); process.exit(0); }
  }
}
console.log(`total windows: ${hits}`);
