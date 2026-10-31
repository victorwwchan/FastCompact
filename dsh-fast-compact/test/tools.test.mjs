import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusText } from '../lib/tools.mjs';

const SHAPE = { refLineFormat: 'thought', thoughtChars: 200 };
const NO_LAST = undefined;

test('tools: /fastcompact reports the debug-dump state, its directory, and the last file', () => {
  const off = statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: false, dir: 'C:\\d\\debug', lastDump: null } });
  assert.ok(off.includes('Debug dumps: off.'), 'off is reported as off');

  const onNoLast = statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: true, dir: 'C:\\d\\debug', lastDump: null } });
  assert.ok(onNoLast.includes('Debug dumps: on → C:\\d\\debug'), 'on names its directory even before any compaction');

  const dump = 'C:\\d\\debug\\session-s1-1761954000000-seq10-2046.txt';
  const on = statusText({ shape: SHAPE, last: NO_LAST, debug: { enabled: true, dir: 'C:\\d\\debug', lastDump: dump } });
  assert.ok(on.includes(`last compaction wrote ${dump}`), 'and the file the last compaction of this session wrote');

  const legacy = statusText({ shape: SHAPE, last: NO_LAST });
  assert.ok(!legacy.includes('Debug dumps'), 'a status without the field (older build) prints no debug line at all');
});
