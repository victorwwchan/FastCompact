// Scratch: why is stats.debugDumpPath unset after compactNow with debug:true?
import { findDsh } from './scripts/find-dsh.mjs';
import { loadRuntime } from './lib/runtime.mjs';
import { createEngineClass } from './lib/engine.mjs';

const entry = findDsh();
if (entry === undefined) { console.error('no dsh'); process.exit(1); }
const runtime = await loadRuntime(entry);
const { Session, agent, engine } = runtime;
const session = new Session({ id: 'probe-dump' });

// minimal log so compactNow has something to shadow
const ev = (t) => ({ type: 'assistant/message', data: { parts: [{ type: 'text', text: t }] } });
session.logAppend(ev('a1')); session.logAppend(ev('a2')); session.logAppend(ev('a3'));

await engine.compactNow(agent, new AbortController().signal);
const record = engine.lastCompaction(session);
console.log('stats keys:', record?.stats && Object.keys(record.stats));
console.log('contextStats?', record?.stats?.contextStats && JSON.stringify(record.stats.contextStats));
console.log('debugDumpPath:', record?.stats?.debugDumpPath ?? '(none)');
process.exit(0);
