/**
 * Text-sizing tests for lib/measure.mjs (no harness needed).
 *
 * Everything this plugin emits is measured in UTF-8 bytes, and every clipped
 * piece names where the whole text can be read back, so a shortened quote is
 * never a dead end. The head gets most of the budget because the first words of
 * a thought already say what the agent was going to do; the tail is kept so a
 * model cut mid-sentence resumes where it stopped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { utf8Bytes, formatKb, oneLine, clipText, quoted } from '../lib/measure.mjs';

test('measure: utf8Bytes counts bytes, not characters', () => {
  assert.equal(utf8Bytes(''), 0, 'empty is zero');
  assert.equal(utf8Bytes('abc'), 3, 'ascii is one byte each');
  assert.equal(utf8Bytes('\u00e9'), 2, 'latin-1 supplement takes two');
  assert.equal(utf8Bytes('\u4e2f\u4e2f'), 6, 'cjk takes three each');
  assert.equal(utf8Bytes(String.fromCodePoint(0x1f600)), 4, 'an astral pair takes four');
});

test('measure: formatKb is one decimal and never negative', () => {
  assert.equal(formatKb(0), '0.0 KB', 'zero');
  assert.equal(formatKb(-5), '0.0 KB', 'negative collapses to zero');
  assert.equal(formatKb(1024), '1.0 KB', 'exact kilobyte');
  assert.equal(formatKb(15_700), '15.3 KB', 'one decimal');
});

test('measure: oneLine folds every whitespace run to a single space', () => {
  assert.equal(oneLine('a\n\n b\t c  '), 'a b c', 'newlines, tabs and runs collapse');
});

test('measure: quoted is one JSON line (control characters escaped)', () => {
  assert.equal(quoted('say "hi"\nnow'), '"say \\"hi\\" now"', 'folded then escaped');
});

test('measure: clipText returns the text as-is when it fits or the budget is zero', () => {
  assert.equal(clipText('', 100), '', 'empty stays empty');
  assert.equal(clipText('  hello \n world \n', 100), 'hello \n world', 'outer whitespace trimmed, inner kept');
  assert.equal(clipText('a longer sentence here', 0), 'a longer sentence here', 'zero budget means the whole text');
  assert.equal(clipText('exactly this', 12), 'exactly this', 'fits exactly');
});

test('measure: clipText keeps both ends and names the restore pointer in the gap', () => {
  const text = 'HEAD'.repeat(30) + 'TAIL'.repeat(30);
  const clipped = clipText(text, 40, 'recall {"seq": 9}', 0.25);
  assert.ok(clipped.startsWith('HEAD'), 'head survives');
  assert.ok(clipped.endsWith('AIL'), 'tail survives (the budget may cut inside a word)');
  assert.ok(clipped.includes('[…] recall {"seq": 9} […]'), 'gap names the pointer');
  assert.ok([...clipped].length <= 42, 'the original text spends at most its budget (plus the gap separators)');
});

test('measure: clipText counts code points, so astral pairs survive whole', () => {
  const emoji = String.fromCodePoint(0x1f600);
  const clipped = clipText(emoji.repeat(20), 10, 'p', 0.3);
  assert.ok(clipped.startsWith(emoji), 'head keeps whole pairs');
  // Iterate code points: an astral char cut in half would show up as a lone
  // surrogate unit, which is what a resumed model cannot read back.
  assert.ok([...clipped].every((unit) => {
    const codePoint = unit.codePointAt(0);
    return codePoint < 0xd800 || codePoint > 0xdfff;
  }), 'no lone surrogate half left behind');
});

test('measure: a tiny budget still emits the pointer and never invents text', () => {
  const clipped = clipText('abcdefghij', 3, 'p', 0.25);
  assert.ok(clipped.includes('[…]'), 'the gap marker survives even the smallest budget');
  assert.ok(!clipped.includes('efgh'), 'the middle of the original is what gets cut');
});
