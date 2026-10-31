/**
 * dsh-fast-compact — the deterministic checkpoint builder.
 *
 * No model is asked to summarize anything. The compacted span is replaced by a
 * fixed set of blocks built straight from the session log, in this order:
 *
 *  1. the newest runtime-context block (superseded copies dropped; when the span
 *     holds none, the newest copy still on disk is carried in — see carriedContext),
 *  2. the newest skill-catalog block (same carry rule),
 *  3. pinned content — ONE line per user message in the span (`retainLength` chars
 *     each plus its `recall {"seq": N}` pointer, never elided) and, below them, a
 *     verbatim copy of every entry the model recalled,
 *  4. the last state of work (files written, commands run, open errors,
 *     last human request),
 *  5. the last agent thought, quoted up to `thoughtChars` (0 = pointer only),
 *  6. the debug trail (config `debug`): failed tool calls worth replaying, each
 *     with its restore seq plus clipped error text (`debugChars`; 0 = seqs only),
 *  7. session-log reference lines for every dropped tool call and result
 *     (`refLineFormat: 'thought' | 'none'`) — ONE index for the WHOLE session: older
 *     traffic is re-read straight from the log through the ranges earlier compactions
 *     shadowed (see shadowedCallEntries), so it survives whatever body replaced them,
 *     a call seq is indexed once, and lines older than this span lead it — until either
 *     the section's byte budget or the row's `contextMaxRatio` share of the MESSAGE
 *     BUDGET the route leaves its window (window − reserved output; the raw window only
 *     when the route names no budget) ages the OLDEST units into one range line: history
 *     is never dropped, only coarsened,
 *  8. the session-log instruction block (config `instructions`, "" = off).
 *
 * Nothing else is carried: no history prose, no excerpts of tool output. The only
 * message text that survives is the clipped line per human turn in the pinned
 * block (plus verbatim copies of whatever the model recalled). Everything the
 * resumed model needs beyond these blocks lives in the session log and comes
 * back through `recall` / `recall_search` by seq.
 *
 * @module dsh-fast-compact/compiler
 */

import { clipText, formatKb, oneLine, utf8Bytes, quoted } from './measure.mjs';
import { buildReferenceLines } from './references.mjs';
import { toolResultsOf, isCheckpointSource } from './messages.mjs';
import { pinsFor } from './pins.mjs';
import {
  DEFAULT_THOUGHT_CHARS,
  DEFAULT_RETAIN_LENGTH,
  DEFAULT_DEBUG,
  DEFAULT_DEBUG_CHARS,
  PINNED_MESSAGE_BYTES,
  PINNED_BLOCK_BYTES,
  REFERENCES_BLOCK_BYTES,
  DEFAULT_CONTEXT_MAX_RATIO,
} from './config.mjs';

/** Context-message `source.kind`s whose newest copy is re-emitted into the window. */
export const CONTEXT_KINDS = Object.freeze(['runtime-context', 'skill-catalog']);

/** Tool names that put a file on disk; these drive the "files written" facts. */
const WRITE_TOOLS = new Set(['write', 'edit', 'apply_patch', 'multiedit', 'notebook_edit']);
/** Tool names whose `command` argument is worth replaying verbatim. */
const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'shell', 'exec']);

export const PINNED_OPEN = '## Pinned content (every user message kept, plus recalled entries verbatim)';
export const STATE_OPEN = '## State of work';
/** Debug trail (row knob `debug`): the failed calls in the span, with restore seqs. */
export const DEBUG_HEADING = '## Debug trail (failed tool calls worth replaying)';
/** Row knob `debug`, second artifact: the window accounting of this compaction. */
export const STATS_HEADING = '## Context window stats (this compaction)';
const DEBUG_MAX_ENTRIES = 8;
/** Smallest reference budget the `contextMaxRatio` guard may shrink the section to. */
const REFERENCE_MIN_BYTES = 1024;
export const REFERENCES_HEADING = '## Session-log references (dropped tool traffic)';
export const INSTRUCTION_HEADING = '## Session-log instruction';

/** Our own resume instructions: they describe exactly what the blocks above carry. */
export const SESSION_LOG_INSTRUCTION = [
  '### Instructions to work with a dsh-fast-compact generated context window:',
  '\tThis context was extracted from current chat session logs by dsh-fast-compact plugin:',
  '\tWe will take first ${thoughtChars} thinking text into context window (see the last agent thought block).',
  '\tTo make it useable and effective to preserve your idea in next context window, pls follow below output format(Must with ✓ on 1st line to indicate you remember this instruction):',
  '\t✓ [1st line: summarize previous actions/results in ~100 words, then state what you will do next in ~100 words]',
  '\t\tdetails that only matter on demand stay in the session log and are retrievable with ${recallTool}',
  '\t(Tool calls and your own thinking now are not carried into the next window — write them freely, keep the two lines above current.)',
  '\tAnything under a reference line — tool output, older reasoning, cut passages — lives only in the session log.',
  '\tRestore it with ${recallTool} {"seq":N} / {"result":N} / {"range":"A-B"}, or find it first with ${searchTool}; do this BEFORE you rely on content you cannot see, and never guess at it.',
].join('\n');

/** Newest copy per context kind, oldest superseded copies dropped (deduped). */
export function contextBlocks(events, kinds = CONTEXT_KINDS) {
  const newest = new Map();
  const seen = new Set();
  for (const event of events) {
    const message = event.type === 'user/message' ? event.data : event.data?.message;
    const kind = typeof message?.source?.kind === 'string' ? message.source.kind : null;
    if (kind === null || !kinds.includes(kind)) continue;
    const text = textOf(message);
    if (text === '') continue;
    if (seen.has(`${kind}:${text}`)) {
      // A repeated identical injection is not new information: the earlier copy
      // is superseded, so only the newest occurrence survives.
      newest.delete(kind);
    }
    seen.add(`${kind}:${text}`);
    newest.set(kind, { kind, seq: event.seq, text });
  }
  return kinds.filter((kind) => newest.has(kind)).map((kind) => newest.get(kind));
}

/** How far back the carry-back scan for a missing context kind reaches (seqs). */
const CONTEXT_CARRY_LOOKBACK = 4096;

/**
 * Newest copy of each `kind` still on disk BEFORE `start`, for kinds the span
 * itself does not hold. The injection of a runtime-context / skill-catalog block
 * usually lives OUTSIDE the compacted range (it sits at the head of an older
 * turn), so a span that contains no instance of a kind would silently drop that
 * block from the resumed window — this walks back from the span and takes the
 * newest copy it finds, either as its own log event or folded inside an earlier
 * checkpoint's text (which is how a context survives after the span around it was
 * already compacted). A kind with no copy inside CONTEXT_CARRY_LOOKBACK stays out.
 *
 * @param {object} session - the session log (eventAt lookup).
 * @param {number} start - first seq of the span being compacted.
 * @param {string[]} kinds - context kinds to look for (CONTEXT_KINDS order).
 * @param {string[]} held - kinds the span already carries.
 * @returns {Array<{kind: string, seq: number, text: string}>} in `kinds` order.
 */
export function carriedContext(session, start, kinds, held) {
  const missing = kinds.filter((kind) => !held.includes(kind));
  if (missing.length === 0) return [];
  const found = new Map();
  for (let seq = start - 1; seq >= 0 && start - seq <= CONTEXT_CARRY_LOOKBACK; seq -= 1) {
    const event = session.eventAt(seq);
    if (event === undefined || event === null) continue;
    if (event.type !== 'user/message') continue;
    const message = event.data;
    if (isCheckpointSource(message?.source)) {
      // An earlier checkpoint already carries its own copy of these blocks.
      for (const kind of missing) {
        if (found.has(kind)) continue;
        const copy = checkpointContextCopy(textOf(message), kind);
        if (copy !== null) found.set(kind, { kind, seq: copy.seq ?? seq, text: copy.text });
      }
      continue;
    }
    const kind = message?.source?.kind;
    if (typeof kind !== 'string' || !missing.includes(kind) || found.has(kind)) continue;
    const text = textOf(message);
    if (text === '') continue;
    found.set(kind, { kind, seq, text });
    if (found.size === missing.length) break;
  }
  return kinds.filter((kind) => found.has(kind)).map((kind) => found.get(kind));
}

/** One `[kind seq N] … [/kind seq N]` block pulled out of an older checkpoint. */
function checkpointContextCopy(text, kind) {
  const open = new RegExp(String.raw`\[${kind} seq (\d+)\]`).exec(text);
  if (open === null) return null;
  const closeIndex = text.indexOf(`[/${kind} seq`, open.index);
  const bodyEnd = closeIndex === -1 ? text.length : closeIndex;
  const body = text.slice(open.index + open[0].length, bodyEnd).trim();
  if (body === '') return null;
  return { seq: Number(open[1]), text: body };
}

/** Joined text content of one message ('' when it carries none). */
function textOf(message) {
  if (message === null || message === undefined) return '';
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** Human turns in a span, oldest first: `{seq, text}` for every real user message. */
export function userMessages(events) {
  const own = [];
  const spliced = [];
  for (const event of events) {
    if (event.type === 'user/message') {
      // Injected context (runtime-context, skill-catalog, time-context), the
      // compact checkpoint itself and tool-result wrappers are not human turns —
      // a message with no declared source is the pre-v4 shape of a real user turn.
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== null && kind !== 'user') continue;
      const text = textOf(event.data);
      if (text !== '') own.push({ seq: event.seq, text });
      continue;
    }
    // The harness also splices a human turn into the next agent turn's inbox
    // (`agent/inbox/spliced` carrying `data.inserted[]`); that insert IS the user
    // message, so name it too — its own seq restores it. Only a declared kind of
    // 'user' counts: a subagent settling through the inbox is not a request.
    if (event.type !== 'agent/inbox/spliced') continue;
    for (const message of (event.data?.inserted ?? [])) {
      if (message === undefined || message === null) continue;
      const kind = message?.source?.kind;
      if (kind !== undefined && kind !== null && kind !== 'user') continue;
      const text = textOf(message);
      if (text !== '') spliced.push({ seq: event.seq, text });
    }
  }
  // A spliced insert of a request the log ALSO records as `user/message` is the
  // same message arriving through a second channel — naming it twice would put a
  // duplicate request in the window. An identical human turn with no such record
  // (the log only holds the inbox copy) is still a real request, so it stays.
  const recorded = new Set(own.map((entry) => entry.text));
  const out = [...own, ...spliced.filter((entry) => !recorded.has(entry.text))];
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Every human turn of the session LOG whose seq `include(seq)` accepts — read back
 * off the log rather than off the surface, so a turn an earlier compaction already
 * replaced is as reachable as one still on it. A request can reach the log through
 * TWO channels: the `user/message` event, and an inbox splice (`agent/inbox/spliced`)
 * that carries the SAME text into the next agent turn. Naming both would put one
 * request in the window twice, so a splice is named ONLY when the log never recorded
 * that text as a real user message — an unrecorded request still has to survive
 * compaction, and this is what keeps spliced-only turns from vanishing silently.
 * @param {object} session - the session whose log holds every event by seq.
 * @param {function} include - predicate over seqs to keep (default: all of them).
 * @returns {Array<{seq,text}>} the kept human turns, oldest first.
 */
export function humanTurns(session, include = () => true) {
  const recorded = new Set();
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined || event.type !== 'user/message') continue;
    const kind = event.data?.source?.kind;
    if (kind !== undefined && kind !== null && kind !== 'user') continue;
    const text = textOf(event.data);
    if (text !== '') recorded.add(text);
  }
  const out = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    if (!include(seq)) continue;
    const event = session.eventAt(seq);
    if (event === undefined) continue;
    if (event.type === 'user/message') {
      const kind = event.data?.source?.kind;
      if (kind !== undefined && kind !== null && kind !== 'user') continue;
      const text = textOf(event.data);
      if (text !== '') out.push({ seq, text });
      continue;
    }
    if (event.type !== 'agent/inbox/spliced') continue;
    for (const message of (event.data?.inserted ?? [])) {
      if (message === undefined || message === null) continue;
      const kind = message?.source?.kind;
      if (kind !== undefined && kind !== null && kind !== 'user') continue;
      const text = textOf(message);
      if (text === '' || recorded.has(text)) continue; // the turn itself is named elsewhere
      out.push({ seq, text });
    }
  }
  return out;
}

/**
 * Pinned content: ONE line per human turn of the WHOLE session — every turn this
 * span holds PLUS every turn an EARLIER compaction already shadowed (read back off
 * the log by `shadowedHumanEntries`) — always present, never elided, at any budget
 * — plus a verbatim copy of every entry the model recalled. A user message is the
 * only thing in the window that carries the request itself, so dropping one would
 * silently delete an instruction the model must keep working to; instead its clip
 * shrinks (`retainLength` chars each) and the seq pointer stays, which restores the
 * full text through `recall`. When the block is full a turn's line degrades to that
 * pointer alone — a seq per turn, never a missing turn. The pointer lines can
 * overflow PINNED_BLOCK_BYTES by a bounded amount (~60 bytes per turn); the verbatim
 * entries below respect whatever budget is left and are skipped when they do not fit.
 *
 * @param {object} events - the events of the span being compacted.
 * @param {Map|Set} pins - seqs the model asked to recall (see lib/pins.mjs).
 * @param {number} retainLength - characters of each user message kept (row knob).
 * @param {Array<{seq,text}>} olderHumans - human turns older than this span (log-wide).
 * @param {Array<{seq,text}>|null} ownHumans - this span's turns when the caller already
 *   read them off the log (`humanTurns`); derived from `events` when it did not.
 */
export function pinnedBlock(events, pins, retainLength = DEFAULT_RETAIN_LENGTH, olderHumans = [], ownHumans = null) {
  const own = ownHumans ?? userMessages(events);
  const ownSeqs = new Set(own.map((entry) => entry.seq));
  const humans = [
    ...olderHumans.filter((entry) => !ownSeqs.has(entry.seq)),
    ...own,
  ].sort((a, b) => a.seq - b.seq);
  if (humans.length === 0 && pins.size === 0) return '';
  const lines = [PINNED_OPEN];
  let used = utf8Bytes(PINNED_OPEN) + 1;
  for (const entry of humans) {
    const recallRef = `recall {"seq": ${entry.seq}}`;
    let line = `- [user seq ${entry.seq}] ${quoted(clipText(oneLine(entry.text), retainLength, '', 0))} — restore with ${recallRef}`;
    if (used + utf8Bytes(line) + 1 > PINNED_BLOCK_BYTES) {
      // The budget is full: keep the pointer alone, still never dropping the turn.
      line = `- [user seq ${entry.seq}] ${recallRef}`;
    }
    used += utf8Bytes(line) + 1;
    lines.push(line);
  }
  for (const event of events) {
    if (!pins.has(event.seq)) continue;
    const text = textOf(event.type === 'user/message' ? event.data : event.data?.message);
    if (text === '') continue;
    const body = clipText(text, PINNED_MESSAGE_BYTES, `recall {"seq": ${event.seq}}`, 0.35);
    const chunk = `[pinned seq ${event.seq}]\n${body}\n[/pinned seq ${event.seq}]`;
    if (used + utf8Bytes(chunk) > PINNED_BLOCK_BYTES) continue;
    used += utf8Bytes(chunk) + 1;
    lines.push(chunk);
  }
  return lines.join('\n');
}

/** Tool traffic in the span: one record per call, linked to its result and thought. */
export function toolTraffic(events) {
  const calls = [];
  const byId = new Map();
  let governing;
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
      for (const block of content) {
        if (block?.type !== 'reasoning') continue;
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        if (text.length > 0) governing = { seq: event.seq, text };
      }
      continue;
    }
    if (event.type === 'tool/call') {
      const record = {
        callSeq: event.seq,
        name: typeof event.data?.name === 'string' ? event.data.name : 'tool',
        arguments: event.data?.arguments,
        thoughtSeq: governing?.seq,
        thoughtText: governing?.text ?? '',
        resultSeq: undefined,
        resultBytes: 0,
        isError: false,
      };
      calls.push(record);
      if (typeof event.data?.callId === 'string') byId.set(event.data.callId, record);
      continue;
    }
    if (event.type === 'tool/result') {
      const message = event.data?.message;
      const result = toolResultsOf(message)[0];
      const target = result !== undefined ? byId.get(result.toolCallId) : undefined;
      const record = target ?? calls.at(-1);
      if (record === undefined || record.resultSeq !== undefined) continue;
      record.resultSeq = event.seq;
      record.resultBytes = utf8Bytes(JSON.stringify(Array.isArray(result?.content) ? result.content : []));
      record.isError = result?.isError === true;
    }
  }
  return calls;
}

/**
 * The last state of work block: what the span did, in seq order.
 * @param {number} thoughtChars - cap on the quoted command text of a failed call.
 * @param {number} retainLength - characters kept of the span's last human request.
 */
export function stateBlock(events, thoughtChars, retainLength = DEFAULT_RETAIN_LENGTH) {
  const lines = [STATE_OPEN];

  let lastUser;
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    const kind = event.data?.source?.kind;
    if (kind !== undefined && kind !== null && kind !== 'user') continue;
    const text = textOf(event.data);
    if (text === '') continue;
    lastUser = { seq: event.seq, text };
  }
  if (lastUser !== undefined) {
    lines.push(`- last user request in this span: seq ${lastUser.seq} — ${quoted(clipText(oneLine(lastUser.text), retainLength, '', 0))}`);
  }

  const writes = [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    if (!WRITE_TOOLS.has(name)) continue;
    const path = pathOf(event.data?.arguments);
    if (path !== '') writes.push({ seq: event.seq, path });
  }
  if (writes.length > 0) {
    lines.push(`- files written in this span (${writes.length}): ${
      writes.slice(-8).map((entry) => `${quoted(entry.path)} (seq ${entry.seq})`).join(', ')}`);
  }

  const commands = [];
  const failed = [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const name = typeof event.data?.name === 'string' ? event.data.name : '';
    if (!COMMAND_TOOLS.has(name)) continue;
    commands.push({ seq: event.seq, command: commandOf(event.data?.arguments) });
  }
  for (const command of commands.slice(-5)) {
    lines.push(`- ran seq ${command.seq}: ${quoted(clipText(command.command, 160, '', 0))}`);
  }

  for (const call of toolTraffic(events)) {
    if (!call.isError) continue;
    failed.push(call);
  }
  for (const failure of failed.slice(-5)) {
    lines.push(`- unresolved error: ${failure.name} (call seq ${failure.callSeq}${failure.resultSeq !== undefined ? `, result seq ${failure.resultSeq}` : ''})`);
  }

  // The pointer only makes sense when the span really carries a thought: a bare
  // span must not promise a block that is never emitted below it.
  if (thoughtChars > 0 && thoughtBlock(events, thoughtChars).thoughtSeq !== undefined) {
    lines.push(`- last agent thought kept verbatim below; continue from its own words, do not re-derive it.`);
  }

  // Heading alone means no facts at all: emit nothing rather than an empty block.
  return lines.length === 1 ? '' : lines.join('\n');
}

/** The file path a write/edit call targets (its `arguments` is a JSON string). */
function pathOf(rawArguments) {
  const parsed = parseArguments(rawArguments);
  if (parsed === null) return '';
  for (const field of ['file_path', 'path', 'notebook_path']) {
    const value = parsed[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '';
}

function commandOf(rawArguments) {
  const parsed = parseArguments(rawArguments);
  if (parsed === null) return '';
  const value = parsed.command;
  return typeof value === 'string' ? value : '';
}

function parseArguments(rawArguments) {
  if (typeof rawArguments === 'string') {
    try {
      const parsed = JSON.parse(rawArguments);
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  if (typeof rawArguments === 'object' && rawArguments !== null && !Array.isArray(rawArguments)) return rawArguments;
  return null;
}

/** The newest agent reasoning block in the span, quoted to `thoughtChars`. */
export function thoughtBlock(events, thoughtChars) {
  let last;
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    const content = Array.isArray(event.data?.message?.content) ? event.data.message.content : [];
    for (const block of content) {
      if (block?.type !== 'reasoning') continue;
      const text = typeof block.text === 'string' ? block.text.trim() : '';
      if (text.length > 0) last = { seq: event.seq, text };
    }
  }
  if (last === undefined) return { block: '', thoughtSeq: undefined };
  if (thoughtChars <= 0) {
    // Zero keeps the pointer only: the words stay in the log and the model reads
    // back exactly what it needs instead of trusting a summary of them.
    return {
      block: `- last agent thought not quoted; resume from its own words with recall {"seq": ${last.seq}}, do not re-derive`,
      thoughtSeq: last.seq,
    };
  }
  return {
    block: `[agent thought seq ${last.seq}]\n${clipText(last.text, thoughtChars, `recall {"seq": ${last.seq}}`, 0.25)}\n[/agent thought seq ${last.seq}]`,
    thoughtSeq: last.seq,
  };
}

/**
 * The debug trail: failed tool calls in the span, oldest dropped first. With
 * `debugChars` > 0 each entry carries the leading error text; at 0 the line is a
 * pointer only — either way the model sees that an error happened and restores
 * the exact text with recall instead of inferring it from a fold line alone.
 * @param {object[]} events - surface events in the span.
 * @param {number} debugChars - characters of error text to keep per entry.
 * @param {string|null} restoreToolName - restore tool this row registered (null = `recall`).
 * @returns {{ block: string, errors: { callSeq: number, resultSeq: number | undefined, name: string }[] }}
 */
export function debugBlock(events, debugChars, restoreToolName) {
  const failures = toolTraffic(events).filter((entry) => entry.isError);
  if (failures.length === 0) return { block: '', errors: [] };
  const kept = failures.slice(-DEBUG_MAX_ENTRIES);
  const lines = [DEBUG_HEADING];
  const tool = restoreToolName ?? 'recall';
  for (const failure of kept) {
    const restoreSeq = failure.resultSeq ?? failure.callSeq;
    const restore = `${tool} {"result": ${restoreSeq}}`;
    const where = failure.resultSeq !== undefined
      ? `call seq ${failure.callSeq}, result seq ${failure.resultSeq}`
      : `call seq ${failure.callSeq}`;
    if (debugChars <= 0) {
      lines.push(`- ${failure.name} failed (${where}): restore with ${restore}`);
      continue;
    }
    const text = clipText(errorTextAt(events, restoreSeq), debugChars, restore, 0.3);
    lines.push(text === '' ? `- ${failure.name} failed (${where})` : `- ${failure.name} failed (${where}): ${quoted(text)}`);
  }
  return {
    block: lines.join('\n'),
    errors: kept.map((failure) => ({ callSeq: failure.callSeq, resultSeq: failure.resultSeq, name: failure.name })),
  };
}

/** Joined text content of the tool result at one seq ('' when it carries none). */
function errorTextAt(events, seq) {
  for (const event of events) {
    if (event.seq !== seq || event.type !== 'tool/result') continue;
    const result = toolResultsOf(event.data?.message)[0];
    return textOf({ role: 'tool', content: Array.isArray(result?.content) ? result.content : [] });
  }
  return '';
}

/**
 * The seq ranges an EARLIER compaction replaced, clipped to what is strictly
 * older than the span now being compacted and sorted oldest first. The host owns
 * these brackets (`compaction/summary` carrying `data.shadowedRange`); the log is
 * append-only, so everything inside a range can still be read back by seq.
 * @param {object} session - the session whose log holds every event by seq.
 * @param {number} start - first seq of the span being compacted now.
 * @returns {Array<{start,end}>} one clipped range per earlier bracket.
 */
function shadowedRanges(session, start) {
  const ranges = [];
  for (let seq = 0; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq);
    if (event === undefined || event.type !== 'compaction/summary') continue;
    const range = event.data?.shadowedRange;
    if (typeof range?.start !== 'number' || typeof range?.end !== 'number') continue;
    if (range.start >= start) continue; // a bracket at or after this span indexes nothing older
    ranges.push({ start: Math.max(0, range.start), end: Math.min(start - 1, range.end) });
  }
  return ranges.sort((a, b) => a.start - b.start);
}

/** One replayed event list per clipped range, oldest range first. */
function eventsInEarlierSpans(session, start) {
  const windows = [];
  for (const range of shadowedRanges(session, start)) {
    if (range.end < range.start) continue;
    const events = [];
    for (let seq = range.start; seq <= range.end; seq += 1) {
      const event = session.eventAt(seq);
      if (event !== undefined) events.push(event);
    }
    windows.push(events);
  }
  return windows;
}

/**
 * Every tool call an EARLIER compaction already shadowed, read straight back out
 * of the session log — so the reference section indexes ALL compacted traffic,
 * whatever spans it sits in, not only the newest one. The bracket events the HOST
 * owns (`compaction/summary` carrying `data.shadowedRange`) name which seq ranges
 * the base replaced; the append-only log still holds the calls, their results and
 * the reasoning that drove them, so `eventAt` reads them even when some other
 * backend wrote the checkpoint body in their place (a range clipped at this span's
 * start still contributes the part before it). Dedup keeps a message out of the
 * section twice: a call seq seen in an overlapping range is indexed once, and
 * anything this span indexes itself is skipped.
 * @param {object} session - the session whose log holds every event by seq.
 * @param {number} start - first seq of the span being compacted now.
 * @returns {object[]} - call entries in the same shape `referenceBlock` builds for
 *   its own span (`{ call, result, thoughtSeq, thoughtText }`), oldest first.
 */
export function shadowedCallEntries(session, start) {
  const entries = [];
  const seen = new Set();
  for (const events of eventsInEarlierSpans(session, start)) {
    for (const entry of toolTraffic(events)) {
      if (entry.callSeq === undefined || seen.has(entry.callSeq)) continue;
      seen.add(entry.callSeq);
      entries.push({
        call: { seq: entry.callSeq, name: entry.name, arguments: entry.arguments },
        result: { seq: entry.resultSeq ?? entry.callSeq, bytes: entry.resultBytes, error: entry.isError },
        thoughtSeq: entry.thoughtSeq,
        thoughtText: entry.thoughtText,
      });
    }
  }
  return entries;
}

/**
 * Every HUMAN turn an earlier compaction already shadowed — the same log-wide walk
 * that feeds the reference index, applied to user messages (see `humanTurns`, which
 * also names a turn that only reached the log as an inbox splice). A user message is
 * the only thing that carries a request, so a turn dropped by an older compaction must
 * still be named in this checkpoint (one line each, clipped to `retainLength`, with
 * its recall pointer); nothing is ever dropped because of a size budget. Overlapping
 * ranges name a seq once, and turns this span holds itself are skipped — the same
 * no-duplicate rule the reference section obeys.
 * @param {object} session - the session whose log holds every event by seq.
 * @param {number} start - first seq of the span being compacted now.
 * @returns {Array<{seq,text}>} real human turns older than this span, oldest first.
 */
export function shadowedHumanEntries(session, start) {
  const ranges = shadowedRanges(session, start).filter((range) => range.end >= range.start);
  if (ranges.length === 0) return [];
  const inRange = (seq) => ranges.some((range) => seq >= range.start && seq <= range.end);
  return humanTurns(session, inRange);
}

/** One collapsed range line an earlier compaction already published. */
const CARRIED_COLLAPSE = /^- (\d+) earlier calls: seq (\d+)–(\d+),/;
/** The structural tail of one reference line: its call and result seqs. */
const CARRIED_TAIL = /→ seq (\d+), result seq (\d+),/;

/** The header line only OUR compiler emits above a reference section. */
const CARRIED_HEADER = new RegExp(`^${REFERENCES_HEADING.replace(/[.*+?^{}()|[\]\\]/g, '\\$&')}: seq \\d+–\\d+$`, 'gm');

/**
 * The reference lines an EARLIER compaction published for spans OLDER than this
 * one, read back off the checkpoint messages the span still holds. Without this
 * the index restarts every time: a re-compaction that folds an older checkpoint
 * into its own span would silently delete the whole tool/thought index of every
 * span before it. Each prior section is transitive by construction (it already
 * carried ITS older spans' lines), so one parse per checkpoint is enough — and
 * `buildReferenceLines` re-collapses the oldest units from the front, so the
 * section keeps a monotone index of ALL compacted traffic within its byte budget.
 * Only a header line this compiler itself emitted (`: seq A–B` on its own line)
 * anchors a section — an LLM summary that merely MENTIONS the heading in prose
 * contributes nothing, and lines matching neither of our two shapes are ignored.
 */
export function carriedReferences(events) {
  const units = [];
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    if (!isCheckpointSource(event.data?.source)) continue;
    const text = textOf(event.data);
    const headers = [...text.matchAll(CARRIED_HEADER)];
    if (headers.length === 0) continue;
    let section = text.slice(headers.at(-1).index + headers.at(-1)[0].length + 1);
    const nextHeading = section.search(/^## /m);
    if (nextHeading >= 0) section = section.slice(0, nextHeading);
    for (const line of section.split('\n')) {
      if (!/^- /.test(line)) continue;
      const collapsed = CARRIED_COLLAPSE.exec(line);
      if (collapsed !== null) {
        units.push({ line, callSeq: Number(collapsed[2]), endSeq: Number(collapsed[3]), count: Number(collapsed[1]) });
        continue;
      }
      const tail = CARRIED_TAIL.exec(line);
      if (tail === null) continue;
      units.push({ line, callSeq: Number(tail[1]), endSeq: Number(tail[1]), count: 1 });
    }
  }
  units.sort((a, b) => a.callSeq - b.callSeq);
  return units;
}

/** Reference section: every dropped call/result pair as one recallable line. */
export function referenceBlock(events, options, older = [], carried = []) {
  const traffic = toolTraffic(events);
  const ownCalls = traffic.filter((entry) => entry.resultSeq !== undefined || entry.callSeq !== undefined).map((entry) => ({
    call: { seq: entry.callSeq, name: entry.name, arguments: entry.arguments },
    result: { seq: entry.resultSeq ?? entry.callSeq, bytes: entry.resultBytes, error: entry.isError },
    thoughtSeq: entry.thoughtSeq,
    thoughtText: entry.thoughtText,
  }));
  const ownSeqs = new Set(ownCalls.map((entry) => entry.call.seq));
  // Older spans lead, in seq order, and a call this span indexes itself is never
  // indexed twice (ranges can overlap, and an overlapping compaction may name it).
  const seen = new Set();
  const freshOlder = [];
  for (const entry of older) {
    const seq = entry.call?.seq;
    if (seq === undefined || ownSeqs.has(seq) || seen.has(seq)) continue;
    seen.add(seq);
    freshOlder.push(entry);
  }
  freshOlder.sort((a, b) => a.call.seq - b.call.seq);
  // Lines an earlier checkpoint published inside THIS span, for traffic the log
  // brackets do not cover — kept only when the log source could not name that call.
  const freshCarried = carried.filter((entry) => !ownSeqs.has(entry.callSeq) && !seen.has(entry.callSeq));
  for (const entry of freshCarried) seen.add(entry.callSeq);
  const { lines, dropped } = buildReferenceLines([...freshOlder, ...ownCalls], {
    format: options.refLineFormat,
    thoughtChars: options.thoughtChars,
    // The engine shrinks this budget when the whole checkpoint would pass the row's
    // `contextMaxRatio` share of the route's MESSAGE BUDGET; the section ages from its
    // oldest unit.
    capBytes: Number.isFinite(options.referenceBytes) ? options.referenceBytes : REFERENCES_BLOCK_BYTES,
    toolNames: options.toolNames,
    carried: freshCarried,
  });
  if (lines.length === 0) return { block: '', refs: 0, dropped: 0, carried: 0 };
  // The section is cumulative now, so its label spans everything it indexes —
  // the oldest older call through the newest result of THIS span.
  const ownCallSeqs = ownCalls.map((entry) => entry.call.seq);
  const olderCallSeqs = [...freshCarried.map((entry) => entry.callSeq), ...freshOlder.map((entry) => entry.call?.seq)];
  const first = Math.min(...(olderCallSeqs.length > 0 ? [Math.min(...olderCallSeqs), ...ownCallSeqs] : ownCallSeqs));
  const resultSeqs = [...ownCalls.map((entry) => entry.result.seq),
    ...freshOlder.map((entry) => entry.result?.seq ?? entry.call?.seq),
    ...freshCarried.map((entry) => entry.endSeq)];
  const last = Math.max(...(resultSeqs.length > 0 ? resultSeqs : ownCallSeqs));
  const recall = options.toolNames?.recall ?? 'recall';
  const search = options.toolNames?.search ?? 'recall_search';
  const header = `${REFERENCES_HEADING}: seq ${first}–${last}\nRestore any original with ${recall} {"seq": N} — several seqs in ONE range request ("a-b"). Need content not visible here? It is still in the FULL session log: call ${search} for it first, then restore the seqs it reports.`;
  return { block: `${header}\n${lines.join('\n')}`, refs: lines.length, dropped, carried: freshOlder.length + freshCarried.length };
}

/** Group a non-negative integer with thousands separators (locale-independent). */
export function groupInt(value) {
  const digits = String(Math.trunc(Math.abs(Number(value ?? 0))));
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return Number(value ?? 0) < 0 ? `-${grouped}` : grouped;
}

/** One percentage with one decimal ('' when the denominator is missing). */
export function shareOf(numerator, denominator) {
  if (typeof numerator !== 'number' || typeof denominator !== 'number' || !(denominator > 0)) return '';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

/**
 * The debug window-accounting block (row knob `debug`): a usage line — the
 * cheapest possible read of "what did this compaction do to my window" — usage
 * before and after as a share of the window, plus the gate that governs the next
 * one and the tool-schema overhead the gate never counts. Every figure comes from
 * the engine's own measurement (`contextStats`, against the token meter and the
 * derived pressure table), never a guess; a route whose capacity could not be read
 * says `n/a` and carries raw token counts instead of invented percentages. The
 * full envelope breakdown (window, budget, headroom, tokens for each figure) stays
 * with `/fastcompact`. When `debug` also attached a dump path, one more line names
 * where this compiled window's on-disk copy lives, so a later agent can pull
 * details that got coarsened into a reference.
 * @param {object|null} stats - numbers from `engine.contextStats` (null = no block); may carry `debugDumpPath`.
 * @returns {string} - the block ('' when there is nothing to report).
 */
export function contextStatsBlock(stats) {
  if (stats === undefined || stats === null) return '';
  const known = typeof stats.contextWindow === 'number' && stats.contextWindow > 0;
  let usageLine;
  if (!known) {
    usageLine = `- usage before compact: n/a of the window (${groupInt(stats.beforeTokens)} tokens, capacity unknown for ${stats.route ?? '(unknown route)'}), after compact: n/a (~${groupInt(stats.afterTokens)} tokens, freed ${groupInt(stats.freedTokens)})`;
  } else {
    const schema = typeof stats.toolSchemaTokens === 'number' && stats.toolSchemaTokens > 0
      ? `; ${groupInt(stats.toolSchemaTokens)} tokens of tool schemas (${shareOf(stats.toolSchemaTokens, stats.contextWindow)} of the window) are priced by the meter but never counted by that gate`
      : '';
    usageLine = `- usage before compact: ${shareOf(stats.beforeTokens, stats.contextWindow)} of the window, after compact: ${shareOf(stats.afterTokens, stats.contextWindow)} (gate ${shareOf(stats.gateTokens, stats.contextWindow)}, freed ${groupInt(stats.freedTokens)} tokens${schema})`;
  }
  const lines = [STATS_HEADING, usageLine];
  // Row knob `debug` also names where this compiled window's on-disk copy lives.
  if (typeof stats.debugDumpPath === 'string' && stats.debugDumpPath !== '') {
    lines.push(`- debug dump: ${stats.debugDumpPath}`);
  }
  return lines.join('\n');
}

/**
 * Compile one span into the checkpoint body.
 * @param {{ start: number, end: number }} range - inclusive surface seq range.
 * @param {object} options - resolved plugin config plus `toolNames` and, when the
 *   row's `debug` is on, `contextStats` from the engine's token-meter measurement.
 * @returns {{ text: string, stats: object }}
 */
export function buildCheckpoint(session, start, end, options = {}) {
  const thoughtChars = options.thoughtChars ?? DEFAULT_THOUGHT_CHARS;
  // ONE knob for every length of human text this checkpoint keeps: each pinned
  // user message line and the state block's "last user request" quote.
  const retainLength = options.retainLength ?? DEFAULT_RETAIN_LENGTH;
  // Debug trail (row knob `debug`): off by default, so the default preset keeps
  // paying zero cost for failed calls; when on, `debugChars` clips each entry's
  // error text (0 = seqs only — the model still sees that a call failed).
  const debugOn = options.debug === undefined ? DEFAULT_DEBUG : options.debug === true;
  const config = { thoughtChars, refLineFormat: options.refLineFormat ?? 'thought', toolNames: options.toolNames };

  const events = [];
  for (let seq = start; seq <= end; seq += 1) {
    const event = session.eventAt(seq);
    if (event !== undefined && event !== null) events.push(event);
  }

  const pins = pinsFor(session);
  const contexts = contextBlocks(events, CONTEXT_KINDS);
  // A context kind the span itself does not hold (its injection sits outside the
  // compacted range, or an earlier compaction already folded it) is carried in
  // from the newest copy still on disk, so runtime context never silently vanishes.
  const carried = carriedContext(session, start, CONTEXT_KINDS, contexts.map((entry) => entry.kind));
  // Human turns come off the LOG on both sides of this span: the turns it holds now,
  // plus every turn an earlier compaction already shadowed — so the pin block names
  // EVERY request this session ever made, never a dropped one (see pinnedBlock). A
  // turn that reached the log only as an inbox splice is named by its own seq.
  const ownHumans = humanTurns(session, (seq) => seq >= start && seq <= end);
  const olderHumans = shadowedHumanEntries(session, start);
  const pinned = pinnedBlock(events, pins, retainLength, olderHumans, ownHumans);
  const state = stateBlock(events, thoughtChars, retainLength);
  const thought = thoughtBlock(events, thoughtChars);
  // Older traffic comes straight from the session log: every seq range an earlier
  // compaction shadowed is re-indexed from its own events (see shadowedCallEntries),
  // so the index covers ALL compacted traffic of this session regardless of which
  // span it sat in and regardless of which backend wrote the body that replaced it.
  // A checkpoint body folded inside THIS span is only a fallback for calls that log
  // could not name, and referenceBlock dedups both sources by call seq — a message
  // is never indexed twice.
  const olderTraffic = shadowedCallEntries(session, start);
  const olderCarried = carriedReferences(events);
  const debug = debugOn
    ? debugBlock(events, options.debugChars ?? DEFAULT_DEBUG_CHARS, options.toolNames?.restore)
    : { block: '', errors: [] };

  // undefined/null → the built-in block; a non-empty string → that text verbatim;
  // '' → the block is disabled (config `instructions: ""`). Placeholders in either
  // text resolve to what this row actually carries.
  const raw = options.instructions === undefined || options.instructions === null ? SESSION_LOG_INSTRUCTION : String(options.instructions).trim();
  const restoreTool = options.toolNames?.recall ?? 'recall';
  const searchTool = options.toolNames?.search ?? 'recall_search';
  const instruction = raw === '' ? '' : raw
    .replaceAll('${thoughtChars}', String(thoughtChars))
    .replaceAll('${recallTool}', restoreTool)
    .replaceAll('${searchTool}', searchTool);

  const contextLines = contexts.concat(carried).map((entry) => `[${entry.kind} seq ${entry.seq}]\n${clipText(entry.text, 6000, `recall {"seq": ${entry.seq}}`, 0.2)}`);
  /** Join every block once the reference section settled on one byte budget. */
  const assemble = (refs) => [
    ...contextLines,
    pinned,
    state,
    thought.block,
    debug.block,
    contextStatsBlock(debugOn ? options.contextStats : null),
    refs.block,
    instruction === '' ? '' : `${INSTRUCTION_HEADING}\n${instruction}`,
  ].filter((block) => block !== '').join('\n');

  // Row knob `contextMaxRatio`: the checkpoint may never occupy more than that share
  // of the window the RESUMED request actually gets — NOT the route's raw context
  // window. The provider charges its output reservation to that same window, so the
  // messages a request carries (this checkpoint among them) only ever travel inside
  // `messageBudgetTokens` = window − reserved output. Sizing the share against the RAW
  // window made one compaction claim 0.25 × 65,535 = 16,383 tokens on strata-llm's 64K
  // route (W=65,535 with O=32,000 reserved), i.e. 49% of the 33,535 tokens that actually
  // fit — enough to push the session past its own gate in a single step. Against the
  // budget the same 0.25 row claims 8,383 tokens = 25% of what the route can carry,
  // which is what the number has always meant to the user (and matches how this plugin
  // already re-expresses `thresholdRatio`: see applyDerivedHeadroom / deriveRoutePressure
  // in lib/engine.mjs). When the route names no budget, the raw window stands in for it
  // — nothing is invented — and the legacy fixed block stays the section budget.
  // Four bytes per token is the estimate used HERE only (the mounted meter prices the
  // finished body exactly, and those are the numbers the stats block reports). The ONLY
  // block allowed to shrink is the reference section: it ages its OLDEST units into one
  // range line, so history is coarsened, never dropped.
  const windowTokens = Number.isFinite(options.contextWindowTokens) ? Math.max(0, Math.floor(options.contextWindowTokens)) : 0;
  const budgetTokens = Number.isFinite(options.messageBudgetTokens) ? Math.max(0, Math.floor(options.messageBudgetTokens)) : 0;
  // A budget wider than the window it sits inside is an inconsistent route reading;
  // fall back to the window rather than trusting a number that cannot bound anything.
  const basisTokens = budgetTokens > 0 && budgetTokens <= windowTokens ? budgetTokens : windowTokens;
  const ratio = Number.isFinite(options.contextMaxRatio) ? options.contextMaxRatio : DEFAULT_CONTEXT_MAX_RATIO;
  const maxBodyBytes = basisTokens > 0 && ratio > 0 ? Math.floor(basisTokens * ratio) * 4 : 0;

  // The section gets the room the cap ACTUALLY leaves it, not the whole share handed
  // over and halved down until the body fit. That start ignored every block that never
  // shrinks beside the references: a share smaller than their cost could never be met,
  // so the loop stopped at the 1 KiB floor still OVER the cap, and on every other route
  // its halvings left room unclaimed (a 64K row paid a 65,532-byte budget whether or not
  // ~5.7 KB of fixed blocks had already eaten part of it). Measuring the body once with
  // the smallest honest section makes the budget land on `cap − what the rest costs`, so
  // one pass is usually exact and the loop below only closes a rounding gap.
  const minimum = referenceBlock(events, { ...config, referenceBytes: REFERENCE_MIN_BYTES }, olderTraffic, olderCarried);
  const minBodyBytes = utf8Bytes(assemble(minimum));
  const slackBytes = maxBodyBytes - minBodyBytes;
  let refBytes = maxBodyBytes > 0
    ? Math.max(REFERENCE_MIN_BYTES, Math.min(maxBodyBytes, REFERENCE_MIN_BYTES + Math.max(0, slackBytes)))
    : REFERENCES_BLOCK_BYTES;
  let refs = referenceBlock(events, { ...config, referenceBytes: refBytes }, olderTraffic, olderCarried);
  let body = assemble(refs);
  // Converge on the cap from there: each step gives back exactly the excess measured.
  while (maxBodyBytes > 0 && utf8Bytes(body) > maxBodyBytes && refBytes > REFERENCE_MIN_BYTES) {
    refBytes = Math.max(REFERENCE_MIN_BYTES, refBytes - (utf8Bytes(body) - maxBodyBytes));
    refs = referenceBlock(events, { ...config, referenceBytes: refBytes }, olderTraffic, olderCarried);
    body = assemble(refs);
  }

  const stats = {
    start,
    end,
    events: events.length,
    contextBlocks: contexts.map((entry) => ({ kind: entry.kind, seq: entry.seq })),
    carriedContexts: carried.map((entry) => ({ kind: entry.kind, seq: entry.seq })),
    pinnedSeqs: [...pins].filter((seq) => seq >= start && seq <= end),
    pinnedUserSeqs: [...new Set([...olderHumans.map((entry) => entry.seq), ...ownHumans.map((entry) => entry.seq)])].sort((a, b) => a - b),
    thoughtSeq: thought.thoughtSeq,
    refs: refs.refs,
    refsDropped: refs.dropped,
    carriedRefs: refs.carried,
    referenceBytes: refBytes,
    debugOn,
    debugEntries: debug.errors.length,
    debugTrail: debug.errors,
    contextStats: debugOn ? options.contextStats ?? null : null,
    bytes: utf8Bytes(body),
  };
  return { text: body, stats };
}
