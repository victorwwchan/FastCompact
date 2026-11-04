/**
 * Generate test/out/keywords-yake.txt from the frozen session fixture.
 *
 * For every `"text": "..."` value in test/fixtures/session.v4.jsonl (the same
 * walk the fixture test uses), run extractKeywords with default options and
 * emit one line per message:
 *
 *   [keyword, keyword, ...] = original text
 *
 * Embedded newlines inside the original text are rendered as ⏎ so each entry
 * stays exactly one line. Run: node scripts/gen-keywords-yake.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractKeywords } from '../lib/yake.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'test', 'fixtures', 'session.v4.jsonl');
const OUT = join(HERE, '..', 'test', 'out', 'keywords-yake.txt');

/**
 * Collect every string value of a key named "text" in the fixture, one entry
 * per occurrence: { line (1-based), type, seq, path, text }. JSON.parse per
 * line so keys inside escaped string content can never false-match.
 */
function collectTexts() {
  const out = [];
  const lines = readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // not a JSONL entry
    }
    const walk = (node, path) => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const [j, item] of node.entries()) walk(item, `${path}[${j}]`);
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'text' && typeof value === 'string') {
          out.push({
            line: i + 1,
            type: entry.type ?? '?',
            seq: entry.seq ?? 0,
            path: path || '(root)',
            text: value,
          });
        } else if (value !== null && typeof value === 'object') {
          walk(value, path ? `${path}.${key}` : key);
        }
      }
    };
    walk(entry.data ?? entry, 'data');
  }
  return out;
}

const cases = collectTexts();
const body = [];
let withHits = 0;
for (const c of cases) {
  const hits = extractKeywords(c.text);
  if (hits.length > 0) withHits += 1;
  const kw = hits.map((h) => h.phrase).join(', ');
  const flat = c.text.replace(/\r?\n/g, '⏎');
  body.push(`[${kw}] = ${flat}`);
}

const header = [
  '# keywords-yake.txt — YAKE keywords per original message',
  `# source: test/fixtures/session.v4.jsonl (${cases.length} "text" values, ${withHits} with keywords)`,
  '# format: [keyword, keyword, ...] = original text (embedded newlines rendered as ⏎)',
  '# generator: scripts/gen-keywords-yake.mjs — extractKeywords defaults (top 15, n 3)',
];

writeFileSync(OUT, header.concat(body).join('\n') + '\n', 'utf8');
console.log(`wrote ${OUT}: ${body.length} entries (${withHits} with keywords)`);
