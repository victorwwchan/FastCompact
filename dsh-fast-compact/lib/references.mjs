/**
 * dsh-fast-compact — session-log reference lines for dropped tool traffic.
 *
 * A compacted span loses every tool call and tool result it contains, but the
 * session log still holds all of them: a reference line names where each one
 * lives so the resumed model can pull the exact original back with `recall`
 * instead of guessing what it was. Only two label shapes exist, chosen by the
 * row key `refLineFormat`:
 *
 *  - `thought` — the line is labelled by the reasoning that drove the call, so
 *    the resumed model sees why the work happened, not only that it did:
 *    `- [read the compiler to find the state block…] (thought seq 193) → seq 196, result seq 197, 15.7 KB`
 *    Consecutive calls governed by the same thought quote it once (parallel
 *    tool-call blocks in one assistant message share their thought), and the
 *    rest of the run carries the bare `(thought seq N)` pointer only.
 *    With `thoughtChars: 0` the excerpt is dropped and every line keeps just
 *    that pointer.
 *  - `none` — labelled by the tool itself, no thought reference at all:
 *    `- read lib/compiler.mjs → seq 196, result seq 197, 15.7 KB`
 *
 * Either way the numbers are the call's own seq and its result's seq, plus the
 * result's size so the model can judge what is worth restoring; a line that
 * ends in `error` marks a call whose result failed.
 *
 * @module dsh-fast-compact/lib/references
 */

import { formatKb, oneLine, utf8Bytes } from './measure.mjs';
import { REF_LINE_FORMATS } from './config.mjs';

/** Row values accepted for the label shape (owned by `config.mjs`). */

/** Fields that identify what a tool was pointed at, most specific first. */
const KEY_ARGUMENT_FIELDS = ['file_path', 'path', 'pattern', 'command', 'query', 'url', 'prompt', 'description'];
const KEY_ARGUMENT_CHARS = 60;

/** Short identity for one call: `read lib/compiler.mjs`, `pwsh node -e "…`. */
function keyArgument(name, rawArguments) {
  let parsed = null;
  if (typeof rawArguments === 'string' && rawArguments.length > 0) {
    try {
      parsed = JSON.parse(rawArguments);
    } catch {
      parsed = null;
    }
  } else if (typeof rawArguments === 'object' && rawArguments !== null) {
    parsed = rawArguments;
  }
  let value = '';
  if (parsed !== null) {
    for (const field of KEY_ARGUMENT_FIELDS) {
      const candidate = typeof parsed === 'object' ? parsed[field] : undefined;
      if (typeof candidate === 'string' && candidate.length > 0) {
        value = candidate;
        break;
      }
    }
  }
  const single = oneLine(value);
  const units = [...single];
  const short = units.length > KEY_ARGUMENT_CHARS ? `${units.slice(0, KEY_ARGUMENT_CHARS).join('')}…` : single;
  return short === '' ? name : `${name} ${short}`;
}

/** Truncate one thought excerpt to `thoughtChars`, keeping its opening words. */
function thoughtExcerpt(text, thoughtChars) {
  const units = [...oneLine(text)];
  if (units.length <= thoughtChars) return units.join('');
  return `${units.slice(0, Math.max(0, thoughtChars)).join('')}…`;
}

/**
 * Render one reference line.
 * @param {{ seq: number, name: string, arguments: unknown }} call
 * @param {{ seq: number, bytes: number, error: boolean }} result
 * @param {{ seq: number|undefined, text: string|null }} thought - governing
 *   thought; `text === null` means its excerpt is suppressed for this line.
 * @param {'thought'|'none'} format - label shape for the whole section.
 * @param {number} thoughtChars - excerpt cap (used only for `thought`).
 */
function referenceLine(call, result, thought, format, thoughtChars) {
  const size = formatKb(result.bytes);
  const failure = result.error ? ', error' : '';
  const pointer = `→ seq ${call.seq}, result seq ${result.seq}, ${size}${failure}`;
  if (format === 'none') return `- ${keyArgument(call.name, call.arguments)} ${pointer}`.trimEnd();
  // A call no thought drove (its own assistant message carried no reasoning) is
  // labelled by the tool itself, exactly as in the `none` shape.
  if (thought.seq === undefined) return `- ${keyArgument(call.name, call.arguments)} ${pointer}`.trimEnd();
  const label = thought.text === null || thought.text === '' || thoughtChars <= 0
    ? `(thought seq ${thought.seq ?? 0})`
    : `[${thoughtExcerpt(thought.text, thoughtChars)}] (thought seq ${thought.seq ?? 0})`;
  return `- ${label} ${pointer}`.trimEnd();
}

/**
 * Build the whole reference section for one compacted span.
 * @param {object[]} calls - every dropped call in span order, each
 *   `{ call, result, thoughtSeq, thoughtText }`.
 * @param {{ format: 'thought'|'none', thoughtChars: number, capBytes: number, toolNames?: {recall, search}, carried?: object[] }} options
 *   `carried` are the reference lines an EARLIER compaction already published for
 *   spans older than this one, each `{ line, callSeq, resultSeq, count }` (see
 *   lib/compiler.mjs carriedReferences): they lead the section, so the index
 *   covers every compacted span instead of restarting at the newest one.
 * @returns {{ lines: string[], dropped: number }} - `dropped` counts the oldest
 *   calls whose line did not fit; a single range line replaces them.
 */
export function buildReferenceLines(calls, options) {
  const format = options.format === 'none' ? 'none' : 'thought';
  const thoughtChars = options.thoughtChars;
  const capBytes = options.capBytes;

  // One governing thought drives every call in a parallel block: quote its words
  // on the run's first line only, so the same prose never repeats in a span. The
  // bare-pointer variant is kept SEPARATELY from the labelled one, because the
  // budget pass below can age the line that quoted a thought into the fold line —
  // a bare pointer may then no longer "continue" anything, and must be re-quoted.
  const units = [];
  for (const entry of options.carried ?? []) {
    if (typeof entry.line !== 'string' || entry.line === '') continue;
    units.push({
      line: entry.line,
      full: entry.line,
      thoughtSeq: undefined,
      callSeq: entry.callSeq,
      endSeq: Number.isFinite(entry.endSeq) ? entry.endSeq : entry.callSeq,
      count: Number.isFinite(entry.count) && entry.count > 1 ? Math.trunc(entry.count) : 1,
    });
  }
  let previousThoughtSeq;
  for (const entry of calls) {
    const labelled = referenceLine(entry.call, entry.result, { seq: entry.thoughtSeq, text: entry.thoughtText }, format, thoughtChars);
    // A call no thought drove has no bare form: its label is the tool itself.
    const bare = entry.thoughtSeq === undefined ? labelled
      : referenceLine(entry.call, entry.result, { seq: entry.thoughtSeq, text: null }, format, thoughtChars);
    units.push({
      line: format === 'thought' && entry.thoughtSeq !== undefined && entry.thoughtSeq === previousThoughtSeq ? bare : labelled,
      full: labelled,
      thoughtSeq: entry.thoughtSeq,
      callSeq: entry.call.seq,
      endSeq: entry.call.seq,
      count: 1,
    });
    previousThoughtSeq = entry.thoughtSeq;
  }

  // The section has a byte budget of its own: the oldest lines — which are now
  // OLDER SPANS' lines first — are the least useful for resuming, so they collapse
  // into one line naming their seq range. Nothing about an older span is ever
  // deleted outright: its calls stay counted and named by that range line. Fitting
  // is priced with the LABELLED form of every line, so re-quoting after the collapse
  // can never push the section past the budget it was promised.
  let kept = units;
  const fits = (candidate) => candidate.reduce((total, unit) => total + utf8Bytes(unit.full) + 1, 0) <= capBytes;
  let droppedCalls = 0;
  while (kept.length > 0 && !fits(kept)) {
    droppedCalls += kept[0].count;
    kept = kept.slice(1);
  }
  // Print: a bare "(thought seq N)" pointer is only legal as the CONTINUATION of a
  // printed line that quoted that same thought. If the budget aged that line into the
  // fold above, this line prints its excerpt again.
  const printed = [];
  let quotedThought;
  for (const unit of kept) {
    const bare = unit.line !== unit.full;
    printed.push(!bare || quotedThought === unit.thoughtSeq ? unit.line : unit.full);
    const seen = /\(thought seq (\d+)\)/.exec(printed.at(-1).replace(/\[[^\]]*\]/g, ''));
    quotedThought = seen ? Number(seen[1]) : undefined;
  }
  const lines = printed;
  if (droppedCalls > 0) {
    const skipped = units.slice(0, units.length - kept.length);
    const first = skipped[0].callSeq;
    const last = skipped.at(-1).endSeq;
    // Name the tools this row actually registered, so a renamed pair still points
    // at something the model can call.
    const restoreTool = options.toolNames?.recall ?? 'recall';
    const searchTool = options.toolNames?.search ?? 'recall_search';
    lines.unshift(`- ${droppedCalls} earlier calls: seq ${first}–${last}, restore with ${restoreTool} or ${searchTool}`);
  }
  return { lines, dropped: droppedCalls };
}
