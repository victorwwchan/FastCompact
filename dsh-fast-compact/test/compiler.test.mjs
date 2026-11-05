/**
 * Compiler tests — the deterministic checkpoint this plugin emits, block by
 * block, with no harness and no LLM in the loop.
 *
 * A compacted span is replaced by a fixed set of blocks built straight from the
 * session log: newest runtime-context / skill-catalog copies, pinned content,
 * the last state of work, the last agent thought quoted to `thoughtChars`,
 * session-log reference lines for dropped tool traffic, and the session-log
 * instruction block. Nothing else is carried — no message text, no history
 * prose, no tool output — so every assertion here names a block boundary or a
 * line the resumed model reads literally.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildEvents } from './helpers.mjs';
import {
  CONTEXT_KINDS,
  PINNED_OPEN,
  STATE_OPEN,
  REFERENCES_HEADING,
  INSTRUCTION_HEADING,
  DEBUG_HEADING,
  STATS_HEADING,
  SESSION_LOG_INSTRUCTION,
  contextBlocks,
  carriedContext,
  carriedReferences,
  shadowedCallEntries,
  shadowedHumanEntries,
  humanTurns,
  userMessages,
  pinnedBlock,
  stateBlock,
  thoughtBlock,
  referenceBlock,
  buildCheckpoint,
  contextStatsBlock,
} from '../lib/compiler.mjs';
import { pin, pinsFor } from '../lib/pins.mjs';
import { REFERENCES_BLOCK_BYTES } from '../lib/config.mjs';

const OPTIONS = { thoughtChars: 200, refLineFormat: 'thought', toolNames: { recall: 'recall', search: 'recall_search' } };

/** A fake session over an events array: seq-indexed lookup plus a surface. */
function fakeSession(events) {
  return {
    id: 'compiler-test',
    seq: events.length,
    eventAt: (seq) => events[seq],
    surface: { nodes: events.map((event) => event.seq) },
  };
}

/** Events carrying injected context messages, including a superseded pair. */
function contextEvents() {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const injection = (kind, text) => ({
    type: 'user/message',
    time: 0,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind }, id: `inj-${kind}` },
  });
  // Log order matters: OLD is superseded by NEW, and DUP repeats — only the
  // newest copy of each kind survives, once.
  return [...events, injection('runtime-context', 'OLD runtime words'), injection('runtime-context', 'NEW runtime words'),
    injection('skill-catalog', '<available_skills>one skill</available_skills>'), injection('runtime-context', 'DUP words'), injection('runtime-context', 'DUP words')];
}

test('compiler: contextBlocks keeps one newest copy per kind in CONTEXT_KINDS order', () => {
  const blocks = contextBlocks(contextEvents());
  assert.deepEqual(blocks.map((entry) => entry.kind), ['runtime-context', 'skill-catalog'], 'order follows CONTEXT_KINDS');
  assert.equal(blocks[0].text, 'DUP words', 'the newest copy wins');
  assert.ok(!blocks.some((entry) => entry.text === 'OLD runtime words'), 'the superseded copy is gone');
  assert.ok(!blocks.some((entry) => entry.text === 'NEW runtime words'), 'so is the one before it');
});

test('compiler: contextBlocks ignores every other message source', () => {
  assert.deepEqual(contextBlocks(buildEvents({ turns: 2, callsPerTurn: 1 })), [], 'a plain session emits no context blocks');
});

/** Re-number a flat event list so array index == seq (fakeSession's lookup). */
function renumber(events) {
  return events.map((event, index) => ({ ...event, seq: index }));
}

const injection = (kind, text) => ({
  type: 'user/message', time: 0,
  data: { role: 'user', content: [{ type: 'text', text }], source: { kind }, id: `inj-${kind}` },
});

test('compiler: carriedContext brings back a context kind the span does not hold', () => {
  const injections = [injection('runtime-context', 'OLD runtime words'), injection('skill-catalog', '<available_skills>one skill</available_skills>')];
  const all = renumber([...injections, ...buildEvents({ turns: 2, callsPerTurn: 1 })]);
  const session = fakeSession(all);
  const start = injections.length;

  assert.deepEqual(carriedContext(session, start, CONTEXT_KINDS, []), [
    { kind: 'runtime-context', seq: 0, text: 'OLD runtime words' },
    { kind: 'skill-catalog', seq: 1, text: '<available_skills>one skill</available_skills>' },
  ], 'both kinds come from before the span');

  const { text, stats } = buildCheckpoint(session, start, all.length - 1, OPTIONS);
  assert.ok(text.includes('[runtime-context seq 0]\nOLD runtime words'), 'the runtime block is back in the resumed window');
  assert.ok(text.includes('[skill-catalog seq 1]'), 'and so is the skill catalog');
  assert.deepEqual(stats.contextBlocks, [], 'the span itself held neither kind');
  assert.deepEqual(stats.carriedContexts, [{ kind: 'runtime-context', seq: 0 }, { kind: 'skill-catalog', seq: 1 }], 'stats name the carried copies');
});

test('compiler: carriedContext reads an older copy folded inside a previous checkpoint', () => {
  const folded = {
    type: 'user/message', time: 0,
    data: { role: 'user', content: [{ type: 'text', text: '## State of work\n[runtime-context seq 3]\nOLD runtime words\n[/runtime-context seq 3]\n- files written: none' }], source: { kind: 'compact-checkpoint' }, id: 'cp' },
  };
  const all = renumber([folded, ...buildEvents({ turns: 2, callsPerTurn: 1 })]);
  const carried = carriedContext(fakeSession(all), 1, CONTEXT_KINDS, []);
  assert.equal(carried.length, 1, 'only the runtime kind is mentioned in that text');
  assert.equal(carried[0].kind, 'runtime-context', 'the folded copy is found');
  assert.equal(carried[0].text, 'OLD runtime words', 'its body is carried without the wrapper');
});

test('compiler: userMessages names every human turn and skips injected context', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const humans = userMessages([...events, injection('runtime-context', 'ignored words'), injection('time-context', 'also ignored')]);
  assert.deepEqual(humans.map((entry) => entry.seq), events.filter((event) => event.type === 'user/message').map((event) => event.seq), 'one entry per human turn');
  assert.ok(!humans.some((entry) => entry.text.includes('ignored words')), 'injected context is not a request');
});

test('compiler: pinnedBlock carries every user message in the span, clipped to retainLength', () => {
  const events = buildEvents({ turns: 3, callsPerTurn: 0 });
  const longUser = {
    type: 'user/message', seq: events.length, time: 1_700_000_000_999,
    data: { role: 'user', content: [{ type: 'text', text: 'Please keep the whole request intact even though it is long: ' + 'tail words'.repeat(40) }], source: { kind: 'user' }, id: 'u-long' },
  };
  const block = pinnedBlock([...events, longUser], new Set(), 60);
  assert.ok(block.startsWith(PINNED_OPEN), 'heading first');
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    assert.ok(block.includes(`[user seq ${event.seq}]`), 'every human turn names its seq');
    assert.ok(block.includes(`recall {"seq": ${event.seq}}`), 'and how to restore all of it');
  }
  assert.ok(!block.includes('tail words tail words tail words tail words tail words tail words tail words'), 'the request is clipped, not carried in full');
  assert.ok(!block.includes('[pinned seq'), 'no verbatim entry without a recall');
});

test('compiler: pinnedBlock keeps a recalled entry verbatim above its pointer line', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 0 });
  const session = fakeSession(events);
  const firstUserSeq = events.find((event) => event.type === 'user/message').seq;
  pin(session, [firstUserSeq]);
  const block = pinnedBlock(events, pinsFor(session), 200);
  assert.ok(block.startsWith(PINNED_OPEN), 'heading first');
  assert.ok(block.includes(`[pinned seq ${firstUserSeq}]`), 'the recalled entry names its seq');
  assert.ok(block.includes('please work on task 1'), 'its words are carried, not summarized');
  assert.ok(block.includes('[user seq 2]') || block.includes('[user seq'), 'an unrecalled turn still keeps its pointer line');
  assert.ok(!block.includes('[pinned seq 999]'), 'nothing unrecalled gets a verbatim copy');
});

test('compiler: pinnedBlock only disappears when there is no human text to keep', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 2 });
  assert.notEqual(pinnedBlock(events, pinsFor(fakeSession(events))), '', 'the human turn still earns a block');
  const contextOnly = [buildEvents({ turns: 0, callsPerTurn: 0 })[0]];
  assert.equal(pinnedBlock(contextOnly, pinsFor(fakeSession(contextOnly))), '', 'no user message and no pins = no heading');
});

test('compiler: stateBlock names the last human request verbatim-quoted', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 0 });
  const block = stateBlock(events, 200);
  assert.ok(block.startsWith(STATE_OPEN), 'heading first');
  const lastUser = events.filter((event) => event.type === 'user/message').at(-1);
  assert.ok(block.includes(`- last user request in this span: seq ${lastUser.seq} — "Turn 2: please work on task 2."`), 'newest human turn, JSON-quoted');

  const longRequest = renumber([...events, injection('user', `Please keep the last request readable: ${'tail words'.repeat(40)}`)]);
  const clipped = stateBlock(longRequest, 200, 40);
  assert.ok(clipped.includes('- last user request in this span:'), 'the newest request is still named');
  assert.ok(!clipped.includes('tail words tail words tail words tail words tail words'), 'retainLength caps it');

  const injectedOnly = renumber(events.filter((event) => event.type !== 'user/message' || event.data?.source?.kind !== 'user'));
  assert.ok(!stateBlock(injectedOnly, 200).includes('last user request'), 'injected context never poses as a request');
});

test('compiler: stateBlock replays files written and commands run with their seqs', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 2 });
  const block = stateBlock(events, 200);
  const writeSeq = events.find((event) => event.type === 'tool/call' && event.data.name === 'write').seq;
  const bashSeq = events.find((event) => event.type === 'tool/call' && event.data.name === 'bash').seq;
  assert.ok(block.includes('- files written in this span (1):'), 'one write fact');
  assert.ok(block.includes(`"src/file_1_1.js" (seq ${writeSeq})`), 'the file names the call that wrote it');
  assert.ok(block.includes(`- ran seq ${bashSeq}:`), 'a command fact per shell call');
});

test('compiler: stateBlock marks an unresolved error with both of its seqs', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const resultEvent = events.find((event) => event.type === 'tool/result');
  resultEvent.data.message.isError = true;
  const callSeq = events.find((event) => event.type === 'tool/call').seq;
  assert.ok(stateBlock(events, 200).includes(`- unresolved error: write (call seq ${callSeq}, result seq ${resultEvent.seq})`), 'both seqs so the model can retry');
});

test('compiler: stateBlock hands the last thought back before it is quoted', () => {
  const block = stateBlock(buildEvents({ turns: 1, callsPerTurn: 1 }), 200);
  assert.ok(block.endsWith('- last agent thought kept verbatim below; continue from its own words, do not re-derive it.'), 'pointer line closes the block');
});

test('compiler: stateBlock emits nothing when the span carries no facts', () => {
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }];
  assert.equal(stateBlock(events, 200), '', 'a bare span contributes no block');
});

test('compiler: thoughtBlock quotes the newest reasoning and names its seq both ways', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const assistantSeq = events.find((event) => event.type === 'assistant/message').seq;
  const { block, thoughtSeq } = thoughtBlock(events, 40);
  assert.equal(thoughtSeq, assistantSeq, 'the pointer is the reasoning event');
  assert.ok(block.startsWith(`[agent thought seq ${assistantSeq}]`), 'open tag names the seq');
  assert.ok(block.endsWith(`[/agent thought seq ${assistantSeq}]`), 'close tag mirrors it');
  assert.ok(block.includes('thinking deeply about turn 1'), 'its own words, not a paraphrase');
});

test('compiler: thoughtChars 0 keeps only the recall pointer for the thought', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const assistantSeq = events.find((event) => event.type === 'assistant/message').seq;
  const { block, thoughtSeq } = thoughtBlock(events, 0);
  assert.equal(thoughtSeq, assistantSeq, 'the seq is still known');
  assert.equal(block, `- last agent thought not quoted; resume from its own words with recall {"seq": ${assistantSeq}}, do not re-derive`, 'pointer line only');
});

test('compiler: a span with no reasoning carries no thought block', () => {
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }];
  assert.deepEqual([thoughtBlock(events, 200)], [{ block: '', thoughtSeq: undefined }], 'nothing to quote');
});

test('compiler: referenceBlock labels its section with the span it covers', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const { block, refs, dropped } = referenceBlock(events, OPTIONS);
  assert.equal(refs, 1, 'one line per dropped call');
  assert.equal(dropped, 0, 'one call never folds');
  const firstCall = events.find((event) => event.type === 'tool/call').seq;
  const lastResult = events.filter((event) => event.type === 'tool/result').at(-1).seq;
  assert.ok(block.startsWith(`${REFERENCES_HEADING}: seq ${firstCall}–${lastResult}`), 'heading names the covered range');
  assert.ok(block.includes('Restore any original with recall {"seq": N}'), 'names the tool that actually restores');
});

test('compiler: referenceBlock labels each line with the thought that drove it', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 2 });
  const { block } = referenceBlock(events, OPTIONS);
  assert.ok(block.includes('[thinking deeply about turn 1 step 1]'), 'first line quotes its own thought');
  assert.ok(block.includes('[thinking deeply about turn 1 step 2]'), 'a different governing thought is quoted again');
});

test('compiler: refLineFormat none drops thought labels entirely', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const { block } = referenceBlock(events, { ...OPTIONS, refLineFormat: 'none' });
  assert.ok(!block.includes('(thought seq'), 'no thought label at all');
  assert.ok(block.includes('- write src/file_1_1.js →'), 'labelled by the tool and its key argument');
});

/** One prior checkpoint message: the body an earlier compaction published. */
function checkpointMessage(text) {
  return {
    type: 'user/message', time: 0,
    data: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint' }, id: 'cp' },
  };
}

/** Padding so a synthetic span starts above the seqs an older checkpoint names. */
const pad = (count) => Array.from({ length: count }, () => ({ type: 'step/start', time: 0, data: { turn: 1, step: 1 } }));

test('compiler: the reference index accumulates across spans instead of restarting', () => {
  // The older traffic is NOT in this window any more — only the checkpoint that
  // replaced it is. So the two older calls can only be re-named through the
  // carried section, which is exactly what a resumed model needs to `recall` them.
  const older = buildEvents({ turns: 2, callsPerTurn: 1 });
  const prior = buildCheckpoint(fakeSession(older), 0, older.length - 1, OPTIONS).text;
  const newer = buildEvents({ turns: 1, callsPerTurn: 1 });
  const all = renumber([...pad(older.length + 2), checkpointMessage(prior), ...newer]);

  const carriedUnits = carriedReferences(all);
  assert.equal(carriedUnits.length, 2, 'both reference lines the previous compaction published are read back');
  assert.ok(carriedUnits[0].callSeq < carriedUnits[1].callSeq, 'oldest first');
  assert.ok(carriedUnits.every((entry) => entry.count === 1), 'a plain line indexes exactly one call');

  const { block, refs, dropped, carried } = referenceBlock(all, OPTIONS, [], carriedUnits);
  assert.equal(carried, 2, 'referenceBlock reports what it carried');
  assert.ok(block.includes(carriedUnits[0].line) && block.includes(carriedUnits[1].line),
    'the older spans keep their lines verbatim');
  assert.ok(block.startsWith(`${REFERENCES_HEADING}: seq ${carriedUnits[0].callSeq}`),
    'the heading names the whole cumulative range, not just this span');
  const ownCallSeq = all.filter((event) => event.type === 'tool/call').at(-1).seq;
  assert.ok(block.indexOf(carriedUnits[0].line) < block.indexOf(`→ seq ${ownCallSeq},`),
    'older lines lead, the newest span keeps the tail');
  assert.equal(dropped, 0, 'the section still fits its budget');
  assert.equal(refs, 3, 'two inherited lines plus this span\'s own');
});

test('compiler: a foreign checkpoint contributes nothing to the index', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 1 });
  const all = renumber([...pad(4), checkpointMessage('## Some other summary\n- it indexed nothing of our shape'), ...events]);
  assert.deepEqual(carriedReferences(all), [], 'lines that match neither of our two shapes are not ours to re-index');
  const { block, carried } = referenceBlock(all, OPTIONS, [], carriedReferences(all));
  assert.equal(carried, 0, 'nothing was carried');
  const ownCall = all.find((event) => event.type === 'tool/call').seq;
  const ownResult = all.filter((event) => event.type === 'tool/result').at(-1).seq;
  assert.ok(block.includes(`→ seq ${ownCall}, result seq ${ownResult}`), 'this span is still indexed normally');
});

/** One host-owned bracket event: the seq range a compaction replaced. */
const summaryEvent = (start, end) => ({ type: 'compaction/summary', time: 0, data: { shadowedRange: { start, end } } });

test('compiler: the index names older traffic straight from the log, whatever wrote its body', () => {
  const first = buildEvents({ turns: 2, callsPerTurn: 1 });
  const second = buildEvents({ turns: 1, callsPerTurn: 1 });
  // Some OTHER engine wrote the replacement checkpoint: nothing of our line shape
  // survives in its prose. The append-only log still holds the calls it replaced and
  // the bracket above them names their range, so the index can still re-name them.
  const all = renumber([
    ...first,
    summaryEvent(0, first.length - 1),
    checkpointMessage('## Written by another engine\n- prose only, no seqs of our shape'),
    ...second,
  ]);
  const start = first.length + 2; // where `second` begins
  const span = all.slice(start);
  const older = shadowedCallEntries(fakeSession(all), start);
  const firstCalls = first.filter((event) => event.type === 'tool/call').map((event) => event.seq);

  assert.equal(older.length, firstCalls.length, 'every shadowed call is read back out of the log');
  assert.deepEqual(older.map((entry) => entry.call.seq), firstCalls, 'oldest first, at the seqs the log holds them at');

  const { block, refs, carried } = referenceBlock(span, OPTIONS, older);
  assert.equal(carried, firstCalls.length, 'referenceBlock reports them as inherited lines');
  assert.equal(refs, firstCalls.length + 1, 'the older span plus this one');
  assert.ok(block.startsWith(`${REFERENCES_HEADING}: seq ${firstCalls[0]}`), 'the heading starts at the OLDEST indexed call, not this span');
});

test('compiler: overlapping shadow ranges name a call once, never twice', () => {
  const first = buildEvents({ turns: 3, callsPerTurn: 1 });
  // Two brackets whose ranges overlap — an older compaction that only replaced part
  // of a span, then one that replaced the rest. One index must still hold one line
  // per call.
  const all = renumber([...first, summaryEvent(0, 5), summaryEvent(3, first.length - 1)]);
  const older = shadowedCallEntries(fakeSession(all), all.length);
  const seqs = older.map((entry) => entry.call.seq);
  assert.deepEqual(seqs, [...new Set(seqs)], 'no call seq is indexed twice');
  const { refs } = referenceBlock(all.slice(first.length), OPTIONS, older);
  assert.equal(refs, older.length, 'the section holds exactly the distinct shadowed calls');
});

test('compiler: the pin block keeps EVERY human turn of the session, older spans included', () => {
  const first = buildEvents({ turns: 3, callsPerTurn: 1 });
  const second = buildEvents({ turns: 2, callsPerTurn: 1 });
  // An earlier compaction replaced `first` (its bracket names the range); the log is
  // append-only, so those human turns are still readable by seq and must survive here.
  const all = renumber([
    ...first,
    summaryEvent(0, first.length - 1),
    checkpointMessage('## Written by another engine\n- prose only, no seqs of our shape'),
    ...second,
  ]);
  const start = first.length + 2; // where `second` begins
  const session = fakeSession(all);

  const older = shadowedHumanEntries(session, start);
  const firstHumans = first.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user').map((event) => event.seq);
  assert.deepEqual(older.map((entry) => entry.seq), firstHumans, 'every human turn the earlier span shadowed comes back off the log');

  const spanHumans = all.slice(start).filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'user').map((event) => event.seq);
  for (const ratio of [0.25, 0.02]) {
    const { text, stats } = buildCheckpoint(session, start, all.length - 1, { ...OPTIONS, contextWindowTokens: 8_000, contextMaxRatio: ratio });
    const lines = text.split('\n').filter((line) => /^- \[user seq \d+\]/.test(line));
    assert.equal(lines.length, firstHumans.length + spanHumans.length,
      `contextMaxRatio ${ratio}: a smaller output share never drops a human turn`);
    for (const seq of [...firstHumans, ...spanHumans]) {
      assert.ok(lines.some((line) => line.startsWith(`- [user seq ${seq}]`)), `the turn at seq ${seq} is named at ratio ${ratio}`);
    }
    assert.deepEqual(stats.pinnedUserSeqs, [...firstHumans, ...spanHumans], 'stats name all of them, oldest first');
  }
});

test('compiler: an inbox-spliced human turn is named once — its echo never twice', () => {
  const first = buildEvents({ turns: 2, callsPerTurn: 1 });
  const second = buildEvents({ turns: 2, callsPerTurn: 1 });
  // The harness splices a human turn into the next agent turn's inbox. Sometimes
  // that insert is an echo of a `user/message` the log already recorded; sometimes
  // it is the ONLY copy of a request. And a subagent can settle through the same
  // channel, which is not a request at all.
  const splice = (text, kind) => ({
    type: 'agent/inbox/spliced', time: 0,
    data: { target: 'next-turn', start: 0, inserted: [{ content: [{ type: 'text', text }], source: { kind }, role: 'user', id: `splice-${kind}` }] },
  });
  const echo = splice('Turn 1: please work on task 1.', 'user'); // also recorded as user/message above
  const only = splice('this request never reached the log as a user message', 'user');
  const settled = splice('a subagent reported back', 'subagent-settled');
  const all = renumber([
    ...first,
    echo,
    only,
    settled,
    summaryEvent(0, first.length + 3), // an earlier compaction replaced all of the above
    checkpointMessage('## Written by another engine\n- prose only, no seqs of our shape'),
    ...second,
  ]);
  const start = first.length + 5; // where `second` begins
  const session = fakeSession(all);

  const echoSeq = first.length;
  const onlySeq = first.length + 1;
  const settledSeq = first.length + 2;
  const turns = humanTurns(session, () => true);
  assert.ok(turns.some((entry) => entry.seq === onlySeq), 'a turn that exists ONLY as an inbox splice still gets a seq');
  assert.ok(!turns.some((entry) => entry.seq === echoSeq), 'the splice echoing a recorded user message is not named twice');
  assert.ok(!turns.some((entry) => entry.seq === settledSeq), 'a subagent settling through the inbox is not a request');

  // And it survives into the pin block at a tiny output budget, next to its turn.
  const { text } = buildCheckpoint(session, start, all.length - 1, { ...OPTIONS, contextWindowTokens: 8_000, contextMaxRatio: 0.02 });
  assert.ok(text.includes(`- [user seq ${onlySeq}]`), 'the spliced-only turn keeps its own pinned line');
  const recorded = all.findIndex((event) => event.type === 'user/message' && event.data?.content?.[0]?.text === 'Turn 1: please work on task 1.');
  assert.ok(text.includes(`- [user seq ${recorded}]`), 'the recorded turn is named exactly once');
});

test('compiler: contextMaxRatio shrinks the reference section and nothing else', () => {
  const events = buildEvents({ turns: 6, callsPerTurn: 3 });
  const session = fakeSession(events);
  const wide = buildCheckpoint(session, 0, events.length - 1, OPTIONS);
  // A route with an 8,000-token window and a row asking for at most 5% of it: the
  // body may not exceed 1,600 bytes, so the reference budget falls from its ratio-sized
  // start toward the documented 1 KiB floor, and the oldest units age into one range line.
  const tight = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, contextWindowTokens: 8_000, contextMaxRatio: 0.05 });

  assert.ok(tight.stats.referenceBytes < Math.min(wide.stats.referenceBytes, REFERENCES_BLOCK_BYTES), 'the section shrank below its default budget');
  assert.ok(/earlier calls: seq \d+–\d+/.test(tight.text), 'the oldest units aged into one range line');
  assert.ok(tight.stats.refs < wide.stats.refs, 'fewer calls named by name, the rest folded');
  for (const [name, block] of [['pinned', PINNED_OPEN], ['state', STATE_OPEN]]) {
    assert.ok(tight.text.includes(block), `${name} block survives the shrink untouched`);
  }
});

test('compiler: a generous ratio lists EVERY indexed call, with no fold line', () => {
  const events = buildEvents({ turns: 6, callsPerTurn: 3 });
  const session = fakeSession(events);
  // A window with room to spare: the section is sized from window × ratio, so it is
  // NOT capped at the legacy fixed block and nothing has to age into a range line.
  const roomy = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, contextWindowTokens: 1_000_000, contextMaxRatio: 0.5 });

  assert.equal(roomy.stats.refsDropped, 0, 'nothing aged into a range line');
  assert.ok(!/earlier calls: seq \d+–\d+/.test(roomy.text), 'no fold line when the whole index fits');
  assert.ok(roomy.stats.referenceBytes > REFERENCES_BLOCK_BYTES, 'the section grew past its legacy fixed budget');
  assert.equal(roomy.stats.refs, events.filter((event) => event.type === 'tool/call').length, 'every call named by name');
});

test('compiler: contextMaxRatio is a share of the MESSAGE BUDGET the route leaves, not its raw window', () => {
  // A span big enough that the reference section is what has to give: 240 indexed calls
  // cannot be named inside a small cap, so these runs differ only by WHERE the cap sits.
  const events = buildEvents({ turns: 40, callsPerTurn: 6 });
  const session = fakeSession(events);
  const windowTokens = 8_000;
  const ratio = 0.5;
  // A route that names its output reservation: the messages a request carries (this
  // checkpoint among them) travel inside window − reserved output, so the row's share
  // governs THAT number. Sizing on the raw window instead let one compaction claim ~49%
  // of what strata-llm/64K can actually carry (0.25 × 65,535 of its 33,535-token budget).
  const budgetTokens = 4_000;
  const capFromWindow = Math.floor(windowTokens * ratio) * 4; // 16,000 bytes
  const capFromBudget = Math.floor(budgetTokens * ratio) * 4; // 8,000 bytes

  const windowRun = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, contextWindowTokens: windowTokens, contextMaxRatio: ratio });
  const budgetRun = buildCheckpoint(session, 0, events.length - 1, {
    ...OPTIONS,
    contextWindowTokens: windowTokens,
    messageBudgetTokens: budgetTokens,
    contextMaxRatio: ratio,
  });

  assert.ok(budgetRun.stats.bytes <= capFromBudget, `the body stayed inside the budget-sized cap (${capFromBudget} bytes)`);
  assert.ok(windowRun.stats.bytes <= capFromWindow, 'and a window-only route is still bounded by its window');
  assert.ok(budgetRun.stats.bytes < windowRun.stats.bytes, 'a budget naming less room than the window tightens the checkpoint');
  assert.ok(budgetRun.stats.referenceBytes < windowRun.stats.referenceBytes, 'the section got the room the tighter cap ACTUALLY leaves');
  assert.ok(budgetRun.stats.refs < windowRun.stats.refs, 'so more of the index aged into the fold line');
  assert.ok(/earlier calls: seq \d+–\d+/.test(budgetRun.text), 'the oldest units folded into one range line');

  // The section is sized from `cap − what the blocks that never shrink cost`, so a run
  // that can be honored lands at the cap instead of stopping at some power-of-two step
  // under it (the old start handed over the whole share and halved down to fit).
  assert.ok(budgetRun.stats.bytes >= capFromBudget - 1_024, `the body filled its cap (${capFromBudget} bytes) rather than halving away from it`);

  // Nothing else may move: the fixed blocks are carried whole at every size.
  for (const [name, marker] of [['pinned', PINNED_OPEN], ['state', STATE_OPEN], ['instruction', INSTRUCTION_HEADING]]) {
    assert.ok(budgetRun.text.includes(marker), `${name} block survives the tighter cap untouched`);
  }
});

test('compiler: a route that names no budget, or an inconsistent one, sizes on the window', () => {
  const events = buildEvents({ turns: 40, callsPerTurn: 6 });
  const session = fakeSession(events);
  const opts = { ...OPTIONS, contextWindowTokens: 8_000, contextMaxRatio: 0.5 };
  const plain = buildCheckpoint(session, 0, events.length - 1, opts);
  const unknown = buildCheckpoint(session, 0, events.length - 1, { ...opts, messageBudgetTokens: 0 });
  // A budget wider than the window it sits inside cannot bound anything — a stale or
  // mismatched capacity reading. The window stands in rather than inventing room.
  const impossible = buildCheckpoint(session, 0, events.length - 1, { ...opts, messageBudgetTokens: 20_000 });

  assert.equal(unknown.stats.bytes, plain.stats.bytes, 'no budget named: the window is the basis');
  assert.equal(impossible.stats.bytes, plain.stats.bytes, 'a budget wider than its window is ignored');
  assert.equal(impossible.stats.referenceBytes, plain.stats.referenceBytes, 'and so is its section budget');
});

test('compiler: a share smaller than the fixed blocks cost lands the section on its floor', () => {
  const events = buildEvents({ turns: 40, callsPerTurn: 6 });
  const session = fakeSession(events);
  // 1% of 8,000 tokens is a 320-byte body — below what the context/pinned/state/thought/
  // instruction blocks cost on their own. The guard still shrinks what it can (the
  // reference section to its documented floor) and reports the minimum honest body.
  const starving = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, contextWindowTokens: 8_000, contextMaxRatio: 0.01 });

  assert.equal(starving.stats.referenceBytes, 1_024, 'the section never goes below its floor');
  assert.ok(/earlier calls: seq \d+–\d+/.test(starving.text), 'and the index is folded to fit it');
  for (const [name, marker] of [['pinned', PINNED_OPEN], ['state', STATE_OPEN]]) {
    assert.ok(starving.text.includes(marker), `${name} block is never traded away to meet an impossible cap`);
  }
});

test('compiler: buildCheckpoint keeps an older checkpoint folded into its own span', () => {
  const older = buildEvents({ turns: 2, callsPerTurn: 1 });
  const prior = buildCheckpoint(fakeSession(older), 0, older.length - 1, OPTIONS).text;
  const newer = buildEvents({ turns: 1, callsPerTurn: 1 });
  const all = renumber([...pad(older.length + 2), checkpointMessage(prior), ...newer]);
  const { stats } = buildCheckpoint(fakeSession(all), 0, all.length - 1, OPTIONS);
  assert.equal(stats.carriedRefs, 2, 'stats name the lines inherited from earlier compactions');
  assert.equal(stats.refs, 3, 'the section covers every span it now indexes');
});

test('compiler: buildCheckpoint emits the blocks in fixed order', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const session = fakeSession(events);
  const { text } = buildCheckpoint(session, 0, events.length - 1, OPTIONS);
  const stateAt = text.indexOf(STATE_OPEN);
  const refsAt = text.indexOf(REFERENCES_HEADING);
  const thoughtAt = text.indexOf('[agent thought seq');
  const instructionAt = text.indexOf(INSTRUCTION_HEADING);
  assert.ok(stateAt >= 0 && refsAt >= 0 && thoughtAt >= 0 && instructionAt >= 0, 'every block present');
  assert.ok(stateAt < thoughtAt && thoughtAt < refsAt && refsAt < instructionAt, 'state → thought → references → instruction');
});

test('compiler: buildCheckpoint stats name exactly what the blocks carry', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const session = fakeSession(events);
  const { stats } = buildCheckpoint(session, 0, events.length - 1, OPTIONS);
  assert.equal(stats.start, 0, 'span start');
  assert.equal(stats.end, events.length - 1, 'span end');
  assert.equal(stats.events, events.length, 'every logged event in the span was read');
  assert.deepEqual(stats.contextBlocks, [], 'the fixture injects no context messages');
  assert.deepEqual(stats.pinnedSeqs, [], 'nothing was recalled before this compaction');
  assert.ok(Number.isInteger(stats.thoughtSeq), 'the thought that survived is named by seq');
  assert.equal(stats.refs, 2, 'one reference line per dropped call');
  assert.equal(stats.refsDropped, 0, 'the section fit its budget');
  assert.ok(stats.bytes > 0, 'bytes counted what was actually emitted');
});

test('compiler: instructions "" disables the block and custom text is carried verbatim', () => {
  const events = buildEvents({ turns: 1, callsPerTurn: 0 });
  const session = fakeSession(events);
  const without = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, instructions: '' });
  assert.ok(!without.text.includes(INSTRUCTION_HEADING), 'no instruction block at all');

  const custom = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, instructions: 'Keep ${thoughtChars} words of thought.' });
  assert.ok(custom.text.includes(`${INSTRUCTION_HEADING}\nKeep 200 words of thought.`), 'substitution uses the resolved cap');

  const builtIn = buildCheckpoint(session, 0, events.length - 1, OPTIONS);
  assert.ok(builtIn.text.includes(SESSION_LOG_INSTRUCTION.split('\n')[0]), 'the built-in block is carried when unset');
});

test('compiler: renamed recall tools are named wherever the checkpoint points at them', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const session = fakeSession(events);
  const renamed = { ...OPTIONS, toolNames: { recall: 'fc_recall', search: 'fc_search' } };
  const text = buildCheckpoint(session, 0, events.length - 1, renamed).text;
  assert.ok(text.includes('Restore any original with fc_recall {"seq": N}'), 'the reference header names the restoring tool');
  assert.ok(text.includes('call fc_search for it first'), 'the header names the search tool');
  assert.ok(text.includes('retrievable with fc_recall'), 'the built-in instruction names the restoring tool');
  assert.ok(text.includes('Restore it with fc_recall {"seq":N}'), 'the built-in restore line names the restoring tool');
  assert.ok(text.includes('find it first with fc_search'), 'the built-in restore line names the search tool');
});

/** Window numbers as one route really reports them (strata-llm/64KB, the tight route).
 * The surface figures are MESSAGE tokens - what the row's gate governs - and the
 * tool-schema part of the envelope is reported separately. */
const WINDOW_STATS = {
  rangeStart: 0,
  rangeEnd: 9,
  beforeTokens: 27_900,
  surfaceTokens: 27_900,
  toolSchemaTokens: 7_682,
  envelopeTokens: 35_582,
  shadowedTokens: 24_180,
  checkpointTokens: 4_930,
  afterTokens: 8_650,
  freedTokens: 19_250,
  route: 'strata-llm/64KB',
  contextWindow: 65_535,
  outputReserved: 32_000,
  messageBudget: 33_535,
  headroomTokens: 2_621,
  thresholdRatio: 0.4605,
  gateTokens: 30_181,
};

test('compiler: the stats block is one line with the window percentages', () => {
  const block = contextStatsBlock(WINDOW_STATS);
  assert.ok(block.startsWith(STATS_HEADING), 'own heading');
  assert.ok(block.split('\n').length === 2, 'heading plus ONE stats line');
  assert.ok(block.includes('- usage before compact: 42.6% of the window, after compact: 13.2%'), 'usage before and after, as shares of the window');
  assert.ok(block.includes('gate 46.1%'), 'and the gate that governs the next compaction');
  assert.ok(block.includes('freed 19,250 tokens'), 'the reduction in tokens');
});

test('compiler: the one-line block states only the window shares', () => {
  const block = contextStatsBlock(WINDOW_STATS);
  assert.ok(block.includes('gate 46.1% of the window'), 'the gate share, in the same basis as the usage shares');
  assert.ok(!block.includes('tool schemas'), 'no envelope breakdown: the gate never counts those tokens, so they stay out of the line');
  assert.ok(!block.includes('of the budget') && !block.includes('headroom'), 'no budget or headroom prose');
});

test('compiler: a gate clamped to what the messages can reach says so', () => {
  const clamped = { ...WINDOW_STATS, requestedGateTokens: 58_982, clampedToCeiling: true, beyondBudget: true };
  const block = contextStatsBlock(clamped);
  assert.ok(block.includes('(the row wanted 90.0% of the window; its messages top out at 46.1%, so it fires there)'), 'the clamp is stated with both shares');
  assert.ok(block.includes('a share past what the messages can hold, so pressure here runs on borrowed time'), 'and that the share sits beyond the message budget');
  assert.ok(!block.includes('message budget'), 'the note is about the shares, not about token arithmetic');
});

test('compiler: an unknown route capacity says n/a and keeps the counts', () => {
  const noCapacity = { ...WINDOW_STATS };
  delete noCapacity.contextWindow;
  delete noCapacity.messageBudget;
  const block = contextStatsBlock(noCapacity);
  assert.ok(block.includes('usage before compact: n/a of the window (27,900 tokens, capacity unknown for strata-llm/64KB)'), 'says so instead of inventing a window');
  assert.ok(block.includes('after compact: n/a (~8,650 tokens, freed 19,250)'), 'token counts still come back');
  assert.ok(!block.includes('% of the window'), 'no window percentages claimed');
});

test('compiler: the stats block names the debug dump file when the row knob attached one', () => {
  const dump = path.join('debug', 'session-s1-1761954000000-seq10-2046.txt');
  const withDump = contextStatsBlock({ ...WINDOW_STATS, debugDumpPath: dump });
  assert.ok(withDump.split('\n').length === 3, 'usage line plus the dump line');
  assert.ok(withDump.includes(`- debug dump: ${dump}`), 'the on-disk copy is named where it lives');
  const unknown = contextStatsBlock({ beforeTokens: 100, afterTokens: 90, gateTokens: 5, freedTokens: 10, route: 'p/m', debugDumpPath: dump });
  assert.ok(unknown.includes(`- debug dump: ${dump}`), 'the capacity-unknown branch carries it too');
  assert.ok(!contextStatsBlock(WINDOW_STATS).includes('debug dump'), 'and nothing is printed when no dump was attached');
});

test('compiler: the debug knob switches on the trail AND the window accounting', () => {
  const events = buildEvents({ turns: 2, callsPerTurn: 1 });
  const session = fakeSession(events);
  const on = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, debug: true, debugChars: 400, contextStats: WINDOW_STATS });
  assert.ok(on.text.includes(STATS_HEADING), 'the accounting block is present once the knob is on');
  const statsAt = on.text.indexOf(STATS_HEADING);
  const refsAt = on.text.indexOf(REFERENCES_HEADING);
  const instructionAt = on.text.indexOf(INSTRUCTION_HEADING);
  assert.ok(statsAt < refsAt && refsAt < instructionAt, 'accounting → references → instruction (the trail sits above it when a call failed)');
  assert.deepEqual(on.stats.contextStats, { ...WINDOW_STATS }, 'the numbers are recorded for /fastcompact as well');

  assert.ok(!on.text.includes(DEBUG_HEADING), 'the fixture has no failed call, so the trail stays out');

  const off = buildCheckpoint(session, 0, events.length - 1, { ...OPTIONS, debug: false, contextStats: WINDOW_STATS });
  assert.ok(!off.text.includes(STATS_HEADING), 'no block without the row knob — one switch drives both');
  assert.equal(off.stats.contextStats, null, 'and nothing is recorded for the command');
});
