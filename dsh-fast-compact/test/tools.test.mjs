import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { Tools } from '../lib/tools.mjs';

const SHAPE = { refLineFormat: 'thought', thoughtChars: 200 };
const NO_LAST = undefined;
const DEBUG_DIR = path.join('d', 'debug');

test('tools: /fastcompact reports the debug-dump state, its directory, and the last file', () => {
  const off = Tools.statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: false, dir: DEBUG_DIR, lastDump: null } });
  assert.ok(off.includes('Debug dumps: off.'), 'off is reported as off');

  const onNoLast = Tools.statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: true, dir: DEBUG_DIR, lastDump: null } });
  assert.ok(onNoLast.includes(`Debug dumps: on → ${DEBUG_DIR}`), 'on names its directory even before any compaction');

  const dump = path.join(DEBUG_DIR, 'session-s1-1761954000000-seq10-2046.txt');
  const on = Tools.statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: true, dir: DEBUG_DIR, lastDump: dump } });
  assert.ok(on.includes(`last compaction wrote ${dump}`), 'and the file the last compaction of this session wrote');

  const legacy = Tools.statusText({ shape: SHAPE, last: NO_LAST });
  assert.ok(!legacy.includes('Debug dumps'), 'a status without the field (older build) prints no debug line at all');
});
