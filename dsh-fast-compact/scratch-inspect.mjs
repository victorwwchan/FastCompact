// Scratch: inspect the events at two seqs of the fixture log, and every human-turn
// channel (user/message vs agent/inbox/spliced inserts) in a seq window.
import fs from 'node:fs';
const lines = fs.readFileSync('scratch-dump.jsonl', 'utf8').split('\n').filter(Boolean);

function textOfContent(content) {
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text).join('\n').trim();
}

for (const line of lines) {
  const event = JSON.parse(line);
  if (event.seq < 3140 || event.seq > 3150) continue;
  const parts = [];
  if (event.type === 'agent/inbox/spliced') {
    for (const item of (event.data?.inserted ?? [])) {
      parts.push(`${item.source?.kind ?? '-'}: ${JSON.stringify(textOfContent(item.content)).slice(0, 80)}`);
    }
  } else {
    parts.push(`${event.data?.source?.kind ?? '-'}: ${JSON.stringify(textOfContent(event.data?.content)).slice(0, 80)}`);
  }
  console.log(`${event.seq} ${event.type} -> ${parts.join(' || ')}`);
}
