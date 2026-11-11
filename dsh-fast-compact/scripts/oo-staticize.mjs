/**
 * scripts/oo-staticize.mjs — turn one lib module's functions into the static
 * methods of a single class, without touching their bodies.
 *
 * The OO pass keeps each file's logic byte-for-byte: this script only
 *   1. rewrites `export function name(` / `function name(` headers to
 *      `static name(` inside a freshly opened `export class Class {`,
 *   2. prefixes every internal call site (`clipText(` -> `Class.clipText(`), and
 *   3. indents the class body by two spaces.
 * Module-level constants and error classes stay OUTSIDE the class — the caller
 * must already have moved any constant that sits below the first function up
 * above it, so the class body holds only methods.
 *
 * Usage (from dsh-fast-compact\):
 *   node scripts/oo-staticize.mjs <ClassName> <file> <name> [<name> ...]
 * The names listed are exactly the members that become static methods; anything
 * else in the file keeps its current position and shape.
 */

import fs from 'node:fs';

const [className, file, ...names] = process.argv.slice(2);
if (!className || !file || names.length === 0) {
  console.error('usage: oo-staticize.mjs <ClassName> <file> <name>...');
  process.exit(1);
}

let src = fs.readFileSync(file, 'utf8');

// 1. headers -> static members (kept at their original column; step 3 indents).
for (const name of names) {
  src = src.replace(new RegExp(`^[ \\t]*(?:export[ \\t]+)?function[ \\t]+${name}\\b`, 'gm'),
    (m) => m.replace(/^[ \t]*(?:export[ \t]+)?function[ \t]+/, 'static '));
}

// 2. internal call sites get the class receiver — never after a dot, and never a
// `static name(` header, which step 1 already put in place.
for (const name of names) {
  src = src.replace(new RegExp(`(^|[^.\\w$'"\`])(?<!static )${name}\\s*\\(`, 'gm'), `$1${className}.${name}(`);
}

// 3. open the class before the first member (and its doc comment), indent the
// body, and close it at end of file.
let firstHeader = -1;
for (const name of names) {
  const at = src.search(new RegExp(`^[ \\t]*static[ \\t]+${name}\\b`, 'gm'));
  if (at >= 0 && (firstHeader < 0 || at < firstHeader)) firstHeader = at;
}
if (firstHeader < 0) {
  console.error(`oo-staticize: none of the named functions found in ${file}`);
  process.exit(1);
}

const NL = String.fromCharCode(10);
const lineStart = src.lastIndexOf(NL, firstHeader) + 1;
const docCandidate = src.lastIndexOf('/**', lineStart);
const insertAt = docCandidate > lineStart ? src.lastIndexOf(NL, docCandidate) + 1 : lineStart;

const head = src.slice(0, insertAt);
const body = src.slice(insertAt).replace(/\s+$/, '');
const indented = body.split(NL).map((line) => (line === '' ? line : `  ${line}`)).join(NL);

fs.writeFileSync(file, `${head}export class ${className} {\n${indented}\n}\n`, 'utf8');
console.log(`${file}: staticized into ${className}`);
