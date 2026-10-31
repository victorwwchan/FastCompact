import { extractKeywords } from '../../lib/yake.mts';
import { EN_STOPWORDS } from '../../lib/stopwords-en.mts';

const corpus = [
  'fast-compact prunes tool results to keep the context window small.',
  'Each checkpoint condenses an old span into a compact summary.',
  'The compaction gate triggers when usage passes forty percent of the window.',
  'Tool results shrink to recall references that point at seq numbers.',
  'The fast-compact preset keeps pinned user messages verbatim inside every checkpoint.',
];
const text = corpus.join('\n');

const hits = extractKeywords(text, { top: 20 });
console.log('top-20 keywords (score, phrase):');
for (const h of hits) console.log(h.score.toFixed(5), h.phrase);

const phrases = hits.map((h) => h.phrase);
const assert = (cond, msg) => { if (!cond) { console.error('FAIL:', msg); process.exit(1); } };

// The distinctive topic phrase of this corpus must surface.
// Distinctive phrases concentrated in the final sentence dominate, as in
// official YAKE output: n-gram score = prod(H) / ((sum(H)+1) * tf).
assert(phrases.includes('pinned user messages'), 'should surface "pinned user messages"');
assert(phrases.some((p) => p.includes('checkpoint')), 'should surface a checkpoint phrase');
assert(hits.every((h) => h.score > 0), 'all scores must be positive');
assert(hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score), 'sorted by score desc');

// Official candidate rule: multi-word phrases start and end with content words
// (interior stopwords are allowed under the 'bi' weighting).
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
