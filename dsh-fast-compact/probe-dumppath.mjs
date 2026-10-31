import { readFileSync } from 'node:fs';

const out = process.argv[2];
const lines = readFileSync(out, 'utf8').split('\n').filter(Boolean);
const recs = lines
  .map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((o) => o && o.type === 'compaction/summary');

for (const o of recs.slice(-4)) {
  console.log('=== seq', o.seq, new Date(o.time).toISOString(), '===');
  console.log('data keys:', JSON.stringify(Object.keys(o.data ?? {})));
  const cs = o.data?.stats?.contextStats;
  if (cs) console.log('stats.contextStats:', JSON.stringify(cs, null, 2));
  else console.log('no stats.contextStats; stats =', JSON.stringify(o.data?.stats ?? null).slice(0, 400));
}
