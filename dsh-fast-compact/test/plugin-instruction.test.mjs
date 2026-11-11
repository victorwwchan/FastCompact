#!/usr/bin/env node
/**
 * test/plugin-instruction.test.mjs — the plugin's OWN per-step instruction.
 *
 * Pure parts only (the mount itself is exercised by scripts/selfcheck.mjs):
 * the exported text, its placeholder rendering against the row's actual tool
 * names, and the source kind the pre-step listener stamps. The compiler-side
 * contract (older copies folding OUT at compaction) is pinned in compiler.test.mjs
 * style here: the kind must NOT be in CONTEXT_KINDS, since unknown kinds are
 * exactly what the compiler drops — pinned only `user` turns, carried only known
 * context kinds.
 *
 * The WORDING is deliberately NOT asserted anywhere: the instruction is prose the
 * maintainer rewrites freely, so this file pins only its STRUCTURE (placeholders,
 * one tight block) and its RENDERING BEHAVIOUR (tool-name placeholders resolve,
 * anything else passes through verbatim for the model to fill in). A test that
 * quoted a sentence of the text would fail on every rewording.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { PLUGIN_INSTRUCTION, PLUGIN_INSTRUCTION_SOURCE_KIND, renderPluginInstruction } from '../index.mjs';
import { CONTEXT_KINDS } from '../lib/compiler.mjs';

/** The placeholder names the renderer resolves; every other token is a pass-through. */
const RESOLVED_PLACEHOLDERS = ['recallTool', 'searchTool'];

/** Placeholder tokens (${name}) appearing in some instruction text, in source order. */
function placeholderNames(text) {
  return [...text.matchAll(/\$\{([A-Za-z][A-Za-z0-9_]*)\}/g)].map((match) => match[1]);
}

await test('plugin instruction: the text names both tool placeholders and stays one block', async () => {
  assert.ok(PLUGIN_INSTRUCTION.length > 0, 'the mount would inject an empty copy otherwise');
  for (const name of RESOLVED_PLACEHOLDERS) {
    assert.ok(placeholderNames(PLUGIN_INSTRUCTION).includes(name),
      `renderer resolves ${'${' + name}'} so the text must use it at least once`);
  }
  assert.ok(!PLUGIN_INSTRUCTION.includes('\n\n'), 'one tight block, no blank lines inside');
  assert.ok(!/\r/.test(PLUGIN_INSTRUCTION), 'no carriage returns: the copy rides one rendered line set');
});

await test('plugin instruction: rendering substitutes the row\'s own tool names', async () => {
  const source = placeholderNames(PLUGIN_INSTRUCTION);
  for (const name of RESOLVED_PLACEHOLDERS) {
    assert.ok(source.includes(name), 'the renderer resolves ${' + name + '}, so the text must use it');
  }

  // Counting with sentinels that cannot occur in prose keeps the check wording-free:
  // each placeholder occurrence turns into exactly one use of the row's own name.
  const sentinel = { recall: '\u0001recall\u0001', search: '\u0002search\u0002' };
  const rendered = renderPluginInstruction(sentinel);
  for (const [name, key] of [['recallTool', 'recall'], ['searchTool', 'search']]) {
    const uses = source.filter((seen) => seen === name).length;
    assert.equal(rendered.split('${' + name + '}').length - 1, 0, 'the placeholder never survives');
    assert.equal(rendered.split(sentinel[key]).length - 1, uses, 'one substitution per placeholder occurrence');
  }

  // A realistic rename: both of the row's names ride in, and no placeholder token stays.
  const named = renderPluginInstruction({ recall: 'recall', search: 'recall_search' });
  assert.ok(named.includes('recall') && named.includes('recall_search'), 'the row names its own tools');
  for (const name of RESOLVED_PLACEHOLDERS) {
    assert.ok(!named.includes('${' + name + '}'), 'resolved placeholder gone from the rendered copy');
  }

  const renamed = renderPluginInstruction({ recall: 'fc_recall', search: 'fc_search' });
  assert.notEqual(renamed, named, 'renaming changes the rendered copy');
  assert.ok(renamed.includes('fc_recall') && renamed.includes('fc_search'), 'a renamed row names its own tools');

  // Tokens the renderer does NOT resolve (a template for the model to fill in, such as a
  // plan subject) must ride verbatim — that pass-through is what keeps this suite wording-free.
  for (const name of new Set(source).difference(new Set(RESOLVED_PLACEHOLDERS))) {
    assert.ok(named.includes('${' + name + '}'), 'unresolved placeholder rides verbatim: ' + name);
  }
});

await test('plugin instruction: its source kind is the compiler-invisible one', async () => {
  assert.equal(PLUGIN_INSTRUCTION_SOURCE_KIND, 'fastcompact-instruction', 'the listener stamp');
  assert.ok(!CONTEXT_KINDS.includes(PLUGIN_INSTRUCTION_SOURCE_KIND),
    'NOT a carried context kind: unknown kinds are neither pinned nor carried, so older injections fold out at the next compaction and the fresh step copy replaces them');
});
