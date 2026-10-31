// Scratch: measure one pinned clip against retainLength and show why it differs.
import fs from 'node:fs';
const lines = fs.readFileSync('scratch-dump.jsonl', 'utf8').split('\n').filter(Boolean);
const RETAIN = 200;

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim();
}

for (const line of lines) {
  const event = JSON.parse(line);
  if (event.seq !== 2230) continue;
  const text = textOfContent(event.data?.content);
  const oneLine = text.replace(/\s+/g, ' ');
  console.log('chars(code points):', [...oneLine].length);
  console.log('utf16 units:', oneLine.length);
  // Show any non-BMP characters (surrogate pairs) that make the two counts differ.
  const pairs = [...oneLine].filter((ch) => ch.length > 1);
  console.log('surrogate-pair chars:', JSON.stringify(pairs));
}
