/**
 * dsh-fast-compact — YAKE keyword scoring, single-document port.
 *
 * Ports the classic YAKE algorithm (Kavumba & Santos 2015; INESCTEC yake
 * v0.4.x) to dependency-free TypeScript: a co-occurrence graph over adjacent
 * tokens plus the H feature score
 *
 *   H = (WPos · WRel) / (WCase + WFreq/WRel + WSpread/WRel)
 *
 * with WRel from in/out edge probabilities (PWL/PWR), WFreq the tf normalised
 * by the content-word mean+stdev, WSpread the sentence coverage and WPos the
 * log-log of the median occurrence sentence. Multi-word candidates use the
 * official 'bi' stopword weighting (prod_H / ((sum_H + 1) · tf)). Nothing
 * statistical is dropped — the official package's graph IS plain
 * co-occurrence, so no node2vec, spacy or numpy was ever required; only
 * virtual (non-contiguous) candidates and lemmatisation are left out. Run
 * natively: Node ≥ 24 strips the types.
 *
 * @module dsh-fast-compact/lib/yake
 */

import { EN_STOPWORDS } from './stopwords-en.mts';

/** One extracted keyword with its YAKE score (higher = more characteristic). */
export interface YakeHit {
  phrase: string;
  score: number;
}

export interface YakeOptions {
  /** How many keywords to return (default 15). */
  top?: number;
  /** Max n-gram length for multi-word candidates (default 3). */
  n?: number;
  /** Stopword set; defaults to the trimmed English list. */
  stopwords?: readonly string[];
}

interface Token {
  word: string;
  stop: boolean;
}

const TOKEN = /[a-z0-9][a-z0-9_-]*/gi;
const EMPTY_OUT = new Map<string, number>();

function median(values: number[]): number {
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 1 ? values[mid]! : (values[mid - 1]! + values[mid]!) / 2;
}

/**
 * Score a text and return its top keywords, single words and n-grams.
 * Deterministic: same text, same options, same list — no randomness, no clock.
 */
export function extractKeywords(text: string, options: YakeOptions = {}): YakeHit[] {
  const top = options.top ?? 15;
  const maxN = Math.max(2, Math.min(5, options.n ?? 3));
  const stops = new Set(options.stopwords ?? EN_STOPWORDS);

  const sentences = text.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim() !== '');
  if (sentences.length === 0 || top <= 0) return [];

  // Tokenise every sentence, keeping stopword marks (the 'bi' weighting needs
  // them inside n-grams) and the case cues for WCase. Case tags follow
  // v0.4.4's getCase: "a" = all letters uppercase, "n" = exactly one leading
  // capital (not at sentence start); anything else earns no case credit.
  const perSentence: Token[][] = [];
  const tf = new Map<string, number>();
  const capsCount = new Map<string, number>();
  const normalCount = new Map<string, number>();
  const occursSent = new Map<string, Set<number>>();
  const graph = new Map<string, Map<string, number>>();
  const edge = (a: string, b: string) => {
    let out = graph.get(a);
    if (out === undefined) graph.set(a, (out = new Map()));
    out.set(b, (out.get(b) ?? 0) + 1);
  };
  for (const [sentId, sentence] of sentences.entries()) {
    const tokens: Token[] = [];
    // Scan with exec so lastIndex advances past the full match; a per-position
    // slice().match() would re-enter each token's tail and emit letter fragments.
    TOKEN.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN.exec(sentence)) !== null) {
      const raw = m[0];
      const word = raw.toLowerCase();
      const stop = stops.has(word) || word.length <= 1;
      if (!stop) tf.set(word, (tf.get(word) ?? 0) + 1);
      const upper = (raw.match(/[A-Z]/g) ?? []).length;
      if (upper > 0 && !/[a-z]/.test(raw)) capsCount.set(word, (capsCount.get(word) ?? 0) + 1);
      else if (upper === 1 && raw.length > 1 && /^[A-Z]/.test(raw) && tokens.length > 0) normalCount.set(word, (normalCount.get(word) ?? 0) + 1);
      const seen = occursSent.get(word);
      if (seen === undefined) occursSent.set(word, new Set([sentId]));
      else seen.add(sentId);
      tokens.push({ word, stop });
    }
    for (let i = 0; i < tokens.length - 1; i += 1) {
      edge(tokens[i]!.word, tokens[i + 1]!.word);
      edge(tokens[i + 1]!.word, tokens[i]!.word);
    }
    perSentence.push(tokens);
  }

  if (tf.size === 0) return [];

  // Content-word frequency statistics (mean + stdev normalise WFreq).
  const frequencies = [...tf.values()];
  const maxTF = Math.max(...frequencies, 0);
  const avgTF = frequencies.reduce((a, b) => a + b, 0) / frequencies.length;
  const stdTF = Math.sqrt(frequencies.reduce((a, b) => a + (b - avgTF) ** 2, 0) / frequencies.length);

  // Single-word H, faithful to v0.4.4 single_word.updateH.
  const hOf = new Map<string, number>();
  for (const word of tf.keys()) {
    const count = tf.get(word)!;
    const out = graph.get(word) ?? EMPTY_OUT;
    let WDR = 0;
    let WIR = 0;
    for (const w of out.values()) {
      WDR += 1;
      WIR += w;
    }
    let WDL = 0;
    let WIL = 0;
    for (const m of graph.values()) {
      const w = m.get(word);
      if (w !== undefined) {
        WDL += 1;
        WIL += w;
      }
    }
    const pwr = WIR === 0 ? 0 : WDR / WIR;
    const pwl = WIL === 0 ? 0 : WDL / WIL;
    const wRel = (0.5 + pwl * (count / maxTF)) + (0.5 + pwr * (count / maxTF));
    const wFreq = count / (avgTF + stdTF);
    const wSpread = occursSent.get(word)!.size / sentences.length;
    const wCase = Math.max(capsCount.get(word) ?? 0, normalCount.get(word) ?? 0) / (1 + Math.log(count));
    const sentIds: number[] = [];
    for (const id of occursSent.get(word)!) sentIds.push(id);
    const wPos = Math.log(Math.log(3 + median(sentIds)));
    hOf.set(word, (wPos * wRel) / (wCase + wFreq / wRel + wSpread / wRel));
  }

  // Candidate collection: every unigram plus adjacent windows of length 2..n
  // with at least one content word. Multi-word candidates score with the
  // official 'bi' compound formula; stopword slots use edge probabilities.
  const hits: YakeHit[] = [];
  for (const word of tf.keys()) hits.push({ phrase: word, score: hOf.get(word)! });
  const seenPhrase = new Map<string, { tf: number; tokens: Token[] }>();
  const addCandidate = (window: Token[]) => {
    // Official candidate rule: multi-word candidates start and end with content words.
    if (window[0]!.stop || window[window.length - 1]!.stop) return;
    const phrase = window.map((t) => t.word).join(' ');
    const known = seenPhrase.get(phrase);
    if (known !== undefined) known.tf += 1;
    else seenPhrase.set(phrase, { tf: 1, tokens: window });
  };
  for (const tokens of perSentence) {
    for (let i = 0; i < tokens.length; i += 1) {
      for (let len = 2; len <= maxN && i + len <= tokens.length; len += 1) addCandidate(tokens.slice(i, i + len));
    }
  }
  for (const [phrase, cand] of seenPhrase) {
    let sumH = 0;
    let prodH = 1;
    const windowTokens = cand.tokens;
    for (let t = 0; t < windowTokens.length; t += 1) {
      const term = windowTokens[t]!;
      if (!term.stop) {
        sumH += hOf.get(term.word)!;
        prodH *= hOf.get(term.word)!;
      } else {
        // 'bi' weighting: P(prev→stop) · P(stop→next) over edge TFs. A stop at
        // the window edge, or next to another stop, has no content neighbor —
        // treat it as neutral (prob 1).
        const prev = windowTokens[t - 1];
        const next = windowTokens[t + 1];
        let prob = 1;
        if (prev !== undefined && next !== undefined && !prev.stop && !next.stop) {
          // Out-degrees come from the bidirectional graph, so raw ratios can
          // exceed 1 on degenerate single-sentence inputs; clamp to [0, 1].
          const p1 = (graph.get(prev.word)?.get(term.word) ?? 0) / tf.get(prev.word)!;
          const p2 = (graph.get(term.word)?.get(next.word) ?? 0) / tf.get(next.word)!;
          prob = Math.min(1, Math.max(0, p1)) * Math.min(1, Math.max(0, p2));
        }
        prodH *= 1 + (1 - prob);
        sumH -= 1 - prob;
      }
    }
    hits.push({ phrase, score: prodH / ((sumH + 1) * cand.tf) });
  }

  hits.sort((a, b) => b.score - a.score || a.phrase.localeCompare(b.phrase));
  return hits.slice(0, top);
}
