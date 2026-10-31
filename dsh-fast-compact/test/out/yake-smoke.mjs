import { extractKeywords } from '../../lib/yake.mts';
import { EN_STOPWORDS } from '../../lib/stopwords-en.mts';

const corpus = [
  'fast-compact pruned tool results from the session log. The session log keeps every entry append-only.',
  'The recall reference stores the seq number so the agent can restore content from the session log later.',
  'We fixed a YAML crash in the parser; the session log now records the fix and the seq of the failing call.',
  'Checkpoints condense old spans; the session log stays intact so any span can be restored by seq.',
];
const text = corpus.join('\n');

const hits = extractKeywords(text, { top: 20 });
console.log('top-20 keywords (score, phrase):');
for (const h of hits) console.log(h.score.toFixed(5), h.phrase);

const phrases = hits.map((h) => h.phrase);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// "session log" is the concentrated topic of this corpus -> must surface.
assert(phrases.includes('session log'), 'should surface "session log"');
assert(phrases.includes('session'), 'should surface "session"');
assert(phrases.includes('recall reference'), 'should surface n-gram "recall reference"');
assert(hits.every((h) => h.score > 0), 'all scores must be positive');

// Official candidate rule: multi-word phrases start and end with content words.
const stops = new Set(EN_STOPWORDS);
for (const p of phrases) {
  const words = p.split(' ');
  if (words.length >= 2) {
    assert(!stops.has(words[0]) && !stops.has(words[words.length - 1]),
      `content-boundary rule violated by "${p}"`);
  }
}

const a = extractKeywords(text, {}), b = extractKeywords(text, {});
assert(JSON.stringify(a) === JSON.stringify(b), 'deterministic across calls');
assert(extractKeywords('', {}).length === 0, 'empty input -> []');
assert(extractKeywords('the and of a an is was', {}).length === 0, 'stopwords only -> []');
console.log('OK — all assertions passed');
