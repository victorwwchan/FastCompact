/**
 * Reference-line tests for lib/references.mjs (no harness needed).
 *
 * Only two label shapes exist — `thought` and `none` — chosen by the row key
 * `refLineFormat`. A `thought` line is labelled by the reasoning that drove the
 * call, so the resumed model sees why the work happened; consecutive calls that
 * one thought governed quote it once and the rest carry the bare pointer. A
 * `none` line is labelled by the tool itself. Either way the numbers are the
 * call's own seq, its result's seq, the result's size, and an `error` marker
 * when the result failed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReferenceLines } from '../lib/references.mjs';

const CALL = { seq: 5, name: 'read', arguments: { file_path: 'dsh-fast-compact/lib/compiler.mjs' } };
const RESULT = { seq: 6, bytes: 15_700, error: false };
const THOUGHT = { thoughtSeq: 4, thoughtText: 'read the compiler to find the state block, then rewrite engine.mjs around it' };

test('refs: none labels the call by the tool and its key argument', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: RESULT, thoughtSeq: undefined, thoughtText: '' }], { format: 'none', thoughtChars: 200, capBytes: 16_000 });
  assert.deepEqual(lines, ['- read dsh-fast-compact/lib/compiler.mjs → seq 5, result seq 6, 15.3 KB'], 'tool + key argument + seq pointers');
});

test('refs: none ignores the thought entirely', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: RESULT, ...THOUGHT }], { format: 'none', thoughtChars: 200, capBytes: 16_000 });
  assert.equal(lines.length, 1, 'one line per call');
  assert.ok(!lines[0].includes('thought'), 'no thought pointer at all');
});

test('refs: thought quotes the governing reasoning, cut to thoughtChars', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: RESULT, ...THOUGHT }], { format: 'thought', thoughtChars: 17, capBytes: 16_000 });
  assert.deepEqual(lines, ['- [read the compiler…] (thought seq 4) → seq 5, result seq 6, 15.3 KB'], 'excerpt then pointer');
});

test('refs: thoughtChars 0 drops the excerpt but keeps the pointer', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: RESULT, ...THOUGHT }], { format: 'thought', thoughtChars: 0, capBytes: 16_000 });
  assert.deepEqual(lines, ['- (thought seq 4) → seq 5, result seq 6, 15.3 KB'], 'pointer only');
});

test('refs: one governing thought quotes its words once per run', () => {
  const calls = [
    { call: { ...CALL, seq: 5 }, result: { ...RESULT, seq: 6 }, ...THOUGHT },
    { call: { ...CALL, seq: 7, name: 'grep' }, result: { ...RESULT, seq: 8, bytes: 900 }, thoughtSeq: 4, thoughtText: THOUGHT.thoughtText },
  ];
  const { lines } = buildReferenceLines(calls, { format: 'thought', thoughtChars: 30, capBytes: 16_000 });
  assert.equal(lines.length, 2, 'one line per call');
  assert.ok(lines[0].startsWith('- ['), 'first line of the run carries the quote');
  assert.ok(lines[1].startsWith('- (thought seq 4)'), 'the repeat carries the bare pointer');
});

test('refs: a call no thought drove falls back to the tool label', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: RESULT, thoughtSeq: undefined, thoughtText: '' }], { format: 'thought', thoughtChars: 200, capBytes: 16_000 });
  assert.deepEqual(lines, ['- read dsh-fast-compact/lib/compiler.mjs → seq 5, result seq 6, 15.3 KB'], 'labelled by the tool, not (thought seq 0)');
});

test('refs: a failed result is marked, so the model knows what to retry', () => {
  const { lines } = buildReferenceLines([{ call: CALL, result: { ...RESULT, error: true }, ...THOUGHT }], { format: 'none', thoughtChars: 200, capBytes: 16_000 });
  assert.ok(lines[0].endsWith(', error'), 'error marker at the end');
});

test('refs: key arguments prefer the most specific field and cut long ones', () => {
  const long = 'x'.repeat(80);
  const lines = buildReferenceLines([
    { call: { seq: 1, name: 'write', arguments: { content: 'ignored', file_path: long } }, result: { seq: 2, bytes: 10 }, thoughtSeq: undefined, thoughtText: '' },
    { call: { seq: 3, name: 'grep', arguments: { pattern: 'compaction-basic' } }, result: { seq: 4, bytes: 10 }, thoughtSeq: undefined, thoughtText: '' },
    { call: { seq: 5, name: 'recall', arguments: { seq: 90 } }, result: { seq: 6, bytes: 10 }, thoughtSeq: undefined, thoughtText: '' },
  ], { format: 'none', thoughtChars: 200, capBytes: 16_000 }).lines;
  assert.ok(lines[0].includes('x'.repeat(60) + '…'), 'file_path wins and cuts at 60 chars');
  assert.ok(lines[1].includes('grep compaction-basic'), 'pattern is a key argument');
  assert.ok(lines[2].startsWith('- recall →'), 'no key argument means the bare tool name');
});

test('refs: an over-budget section folds its oldest lines into one range line', () => {
  const calls = [];
  for (let index = 0; index < 6; index += 1) {
    calls.push({
      call: { seq: 10 + index * 2, name: 'pwsh', arguments: { command: 'node --test' } },
      result: { seq: 11 + index * 2, bytes: 4000, error: false },
      thoughtSeq: undefined,
      thoughtText: '',
    });
  }
  const { lines, dropped } = buildReferenceLines(calls, { format: 'none', thoughtChars: 200, capBytes: 150 });
  assert.ok(dropped > 0, 'the oldest calls folded');
  assert.equal(lines[0], '- 4 earlier calls: seq 10–16, restore with recall or recall_search', 'one range line names the folded calls by their seq range');
  assert.ok(lines.at(-1).includes('seq 20, result seq 21'), 'the newest call keeps its own line');
});

test('refs: the fold line names the restore/search tools the row registered', () => {
  const calls = [];
  for (let index = 0; index < 6; index += 1) {
    calls.push({
      call: { seq: 10 + index * 2, name: 'pwsh', arguments: { command: 'node --test' } },
      result: { seq: 11 + index * 2, bytes: 4000, error: false },
      thoughtSeq: undefined,
      thoughtText: '',
    });
  }
  const { lines } = buildReferenceLines(calls, { format: 'none', thoughtChars: 200, capBytes: 150, toolNames: { recall: 'fc_recall', search: 'fc_search' } });
  assert.equal(lines[0], '- 4 earlier calls: seq 10–16, restore with fc_recall or fc_search', 'renamed tools are named as configured');
});

test('refs: a section that fits emits no fold line', () => {
  const { lines, dropped } = buildReferenceLines([
    { call: CALL, result: RESULT, ...THOUGHT },
  ], { format: 'thought', thoughtChars: 200, capBytes: 16_000 });
  assert.equal(dropped, 0, 'nothing folded');
  assert.equal(lines.length, 1, 'the call keeps its own line');
});

test('refs: carried lines of OLDER spans lead the section and never vanish', () => {
  const carried = [
    { line: '- 3 earlier calls: seq 1–3, restore with recall or recall_search', callSeq: 1, endSeq: 3, count: 3 },
    { line: '- [older thought words] (thought seq 2) → seq 4, result seq 5, 2.1 KB', callSeq: 4, count: 1 },
  ];
  const { lines, dropped } = buildReferenceLines(
    [{ call: CALL, result: RESULT, ...THOUGHT }],
    { format: 'thought', thoughtChars: 200, capBytes: 16_000, carried },
  );
  assert.equal(lines.length, 3, 'both older lines and this span\'s own line are present');
  assert.ok(lines[0].includes('seq 1–3'), 'the oldest span still leads, as its own fold line');
  assert.ok(lines[1].includes('(thought seq 2)'), 'the older span keeps its own line verbatim');
  assert.ok(lines.at(-1).includes('seq 5, result seq 6'), 'the newest call is the tail');
  assert.equal(dropped, 0, 'a section that fits folds nothing, however many spans it indexes');
});

test('refs: the budget ages OLDER spans first and their calls stay counted', () => {
  const carried = [
    { line: '- 3 earlier calls: seq 1–3, restore with recall or recall_search', callSeq: 1, endSeq: 3, count: 3 },
    { line: '- [older thought words] (thought seq 2) → seq 4, result seq 5, 2.1 KB', callSeq: 4, count: 1 },
  ];
  const calls = [];
  for (let index = 0; index < 2; index += 1) {
    calls.push({
      call: { seq: 30 + index * 2, name: 'pwsh', arguments: { command: 'node --test' } },
      result: { seq: 31 + index * 2, bytes: 4000, error: false },
      thoughtSeq: undefined,
      thoughtText: '',
    });
  }
  const { lines, dropped } = buildReferenceLines(calls, { format: 'none', thoughtChars: 200, capBytes: 150, carried });
  assert.ok(dropped >= 4, 'the carried calls are aged before this span\'s own');
  assert.ok(lines[0].includes('seq 1–'), 'the fold starts at the OLDEST indexed seq, not at this span');
  assert.ok(lines.at(-1).includes('seq 32, result seq 33'), 'the newest call still keeps its line');
});

