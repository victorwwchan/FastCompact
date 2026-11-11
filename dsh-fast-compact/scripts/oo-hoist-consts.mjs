// Move module-level const/export-const declarations that landed INSIDE a class body
// back ABOVE the class opener, dedented by two spaces.  Only declarations sitting at
// the class-body indent (exactly two spaces) are rescued, so statements inside method
// bodies are never touched.  Purely positional: no logic is changed.
// Usage: node scripts/oo-hoist-consts.mjs <file> <ClassName>

import fs from 'node:fs';

const [file, className] = process.argv.slice(2);
if (!file || !className) {
  console('usage: oo-hoist-consts.mjs <file> <ClassName>');
  process.exit(1);
}

const text = fs.readFileSync(file, 'utf8');
const nl = text.includes('\r\n') ? '\r\n' : '\n';
const lines = text.split(/\r?\n/);

let opener = -1;
for (let i = 0; i < lines.length; i++) {
  if (new RegExp(`^export class ${className} \\{\\s*$`).test(lines[i])) { opener = i; break; }
}
if (opener === -1) { console(`${file}: no class opener found`); process.exit(1); }

// Class-body-level declarations: two-space indent, ALL-CAPS name, `=`.
const isDeclStart = (line) => /^ {2}(?:export )?const [A-Z][A-Z_0-9]*(\s*=| \()/.test(line);

const blocks = [];
let i = opener + 1;
while (i < lines.length) {
  if (!isDeclStart(lines[i])) { i++; continue; }
  const start = i;
  let depth = 0;
  while (i < lines.length) {
    for (const ch of lines[i]) {
      if (ch === '{' || ch === '(' || ch === '[') depth++;
      else if (ch === '}' || ch === ')' || ch === ']') depth--;
    }
    i++;
    if (depth <= 0) break;
  }
  while (i < lines.length && lines[i].trim() === '') i++;
  blocks.push([start, i - 1]);
}
if (blocks.length === 0) { console(`${file}: nothing to hoist`); process.exit(0); }

// Insert above the doc comment that precedes the class opener.
let insertAt = opener;
while (insertAt > 0 && (/^\s*\*/.test(lines[insertAt - 1]) || /^\/\*\*/.test(lines[insertAt - 1]))) insertAt--;

const skip = new Set();
for (const [a, b] of blocks) for (let n = a; n <= b; n++) skip.add(n);

const hoisted = blocks.flatMap(([a, b]) => lines.slice(a, b + 1).map((line) => line.replace(/^ {2}/, '')));
hoisted.push('');

const rest = lines.filter((_, n) => !skip.has(n));
const out = [];
for (let n = 0; n < rest.length; n++) {
  // Re-insert the kept lines, splitting at the (shifted) class opener position.
  out.push(rest[n]);
}
const openerInRest = rest.findIndex((line) => /^export class /.test(line));
const finalLines = [].concat(
  rest.slice(0, openerInRest),
  hoisted,
  rest.slice(openerInRest),
);

fs.writeFileSync(file, finalLines.join(nl), 'utf8');
process.stdout.write(`${file}: hoisted ${blocks.length} const block(s) above class ${className}\n`);
