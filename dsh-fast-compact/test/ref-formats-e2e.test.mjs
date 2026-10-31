/**
 * e2e test: run the real fast-compact engine on a COMMITTED SAMPLE session log —
 * `test/fixtures/session-fa7af7bf-afee-45bf-b552-e2b5b21276eb.v4.jsonl.zstd`, a
 * frozen copy of this workspace's own durable session log (the fast-compact
 * preset running live, so it carries real compaction traffic) — once per
 * `refLineFormat`: the TWO shapes this plugin owns (`thought`, `none`) at
 * `thoughtChars` 0 and 200: four runs over the SAME real span.
 *
 * The sample is committed on disk so the report says the same thing every run: a
 * live scan would pick whichever log is newest THIS minute — usually this very
 * session, whose surface collapses right after its own checkpoint commits, and
 * then the base legitimately answers "nothing to shadow". Pass an explicit file
 * as argv[2] to judge another log; with NO fixture present the test falls back
 * to the newest compactable live log (see `chooseSessionFile` below) and says so.
 *
 * The testing result is saved inside the test folder:
 *   test/out/ref-formats-e2e-report.md          one table + the section of every run
 *   test/out/checkpoints/<run>.txt              the full checkpoint body of every run
 *
 * Regenerate the sample (PowerShell, from dsh-fast-compact\):
 *   Copy-Item <session.v4.jsonl.zstd under .dsh\sessions\--C-Users-vic-.dsh-fast-compact--\...> \
 *     test\fixtures\session-fa7af7bf-afee-45bf-b552-e2b5b21276eb.v4.jsonl.zstd
 *
 * Run it (from dsh-fast-compact\, PowerShell; `node --test` cannot spawn here):
 *   $env:DSH_ENTRY='C:\Users\vic\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\lib\bin.js'
 *   node test/ref-formats-e2e.test.mjs           2>$null; "exit=$LASTEXITCODE"
 *
 * Skipped when dsh is not installed or the sample log cannot be compacted. The
 * durable log is only ever READ; the open tail turn is closed in memory so the
 * engine's open-turn guard can pass, and nothing is written back to the session
 * store.
 *
 * @module dsh-fast-compact/test/ref-formats-e2e
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findDsh } from '../scripts/find-dsh.mjs';
import { loadRuntime } from '../lib/runtime.mjs';
import { createEngineClass, ENGINE_PROVIDER, ENGINE_MODEL } from '../lib/engine.mjs';
import { buildCheckpoint, userMessages, humanTurns, PINNED_OPEN, carriedReferences, shadowedCallEntries, shadowedHumanEntries } from '../lib/compiler.mjs';
import { recall } from '../lib/recall.mjs';
import { REF_LINE_FORMATS, REFERENCES_BLOCK_BYTES, DEFAULT_RETAIN_LENGTH, DEFAULT_CONTEXT_MAX_RATIO } from '../lib/config.mjs';
import { pinsFor } from '../lib/pins.mjs';

const HERE = dirname(fileURLToPath(import.meta.url)); // dsh-fast-compact\test
const OUT_DIR = join(HERE, 'out');
const CKPT_DIR = join(OUT_DIR, 'checkpoints');

// The window this log's own route declares, and the share of it the compiled
// checkpoint may occupy. The reference section is sized from THAT product (not a
// fixed block), so these two numbers decide how much of the session's older tool
// traffic gets listed line by line instead of collapsing into one range line.
const CONTEXT_WINDOW_TOKENS = 65_535;
const CONTEXT_MAX_RATIO = DEFAULT_CONTEXT_MAX_RATIO;

/**
 * The committed sample log this test runs against: a frozen copy of this
 * workspace's own session log (same id, `agentPreset: fast-compact`, real
 * compaction traffic — about 3 MiB compressed, a few thousand JSONL lines; the
 * report prints the exact event count for the run). Committing it keeps the four
 * runs deterministic; a live scan would judge whatever log happens to be newest
 * this minute — usually this very session, whose surface collapses right after
 * its own checkpoint commits, and then the base legitimately answers "nothing to
 * shadow". Pass an explicit file as argv[2] to judge another log; with NO fixture
 * present the test falls back to the newest compactable live log (see
 * `sessionLogCandidates` below) and says so in the report.
 */
const FIXTURE = join(HERE, 'fixtures', 'session-fa7af7bf-afee-45bf-b552-e2b5b21276eb.v4.jsonl.zstd');

// Remove every regular file under dir, leaving the directory tree itself in place.
// Used instead of rmSync(dir): Windows refuses to delete a directory that is some
// other process's current working directory (rm answers EPERM), and that is an
// environment artifact, not a test failure. The report and the checkpoints are
// rewritten below, so only stale leftovers have to go.
function removeStaleGeneratedFiles(dir) {
  mkdirSync(dir, { recursive: true });
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) removeStaleGeneratedFiles(p);
    else unlinkSync(p);
  }
}

const entry = findDsh();
const skip = entry === undefined ? 'dsh is not installed' : false;

// ---------------------------------------------------------------- zstd frames
const ZSTD_MAGIC = 4247762216;

function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`bad frame magic at ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    offset += (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      offset += blockType === 1 ? 1 : blockSize;
      if (lastBlock) break;
    }
    if (checksum) offset += 4;
    frames.push({ start, end: offset });
  }
  return { frames };
}

function loadLogEvents(file) {
  const raw = readFileSync(file);
  const { frames, tornStart } = scanZstdFrames(raw);
  const chunks = frames.map((frame) => zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)));
  if (tornStart !== undefined) console.log(`(note: trailing incomplete frame at byte ${tornStart} ignored)`);
  const jsonl = Buffer.concat(chunks).toString('utf8');
  const lines = jsonl.split('\n').filter((line) => line.trim().length > 0);
  return { events: lines.map((line) => JSON.parse(line)), rawBytes: raw.length, plainBytes: Buffer.byteLength(jsonl), frames: frames.length };
}

// ---------------------------------------------------------------- locate a usable session log
/**
 * The log this run judges, in the order it is tried. argv[2] wins (judge any
 * log); otherwise the committed `test/fixtures` sample is the ONLY candidate —
 * the report then says "fixture" and four runs over the same span answer the
 * same way every time. With no fixture checked out (fresh clone), fall back to
 * every durable session log for this workspace, newest first, and let
 * `chooseSessionFile` probe them; the report names that fallback.
 */
function sessionLogCandidates() {
  // Only a session-log path counts as "explicit": with `--experimental-test-isolation=none`
  // this module shares the RUNNER's argv, whose entries are the other test files.
  const explicit = process.argv.slice(2).find((arg) => /\.(zstd|jsonl|json)$/.test(arg) && existsSync(arg));
  if (explicit) return [explicit];
  if (existsSync(FIXTURE)) return [FIXTURE];
  const root = join(process.env.USERPROFILE || process.homedir(), '.dsh', 'sessions', '--C-Users-vic-.dsh-fast-compact--');
  let candidates;
  try {
    candidates = readdirSync(root).flatMap((name) => {
      const dir = join(root, name);
      try {
        if (!statSync(dir).isDirectory()) return [];
        const file = join(dir, 'session.v4.jsonl.zstd');
        return statSync(file).size > 0 ? [file] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
  candidates.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return candidates;
}

/**
 * Pick the newest log this run can COMPACT, not just the newest log there is.
 *
 * This workspace's newest log is almost always the session running this very
 * test: fast-compact is live here, so its own checkpoint has already committed
 * and the post-compaction surface can be tiny — the base then answers "nothing
 * to shadow", and every shape check below would be judging an empty span. So
 * probe newest-first with a real compaction (`compactNow`, the same call the
 * runs make) and take the first log whose committed span carries enough real
 * tool traffic to judge the shapes. Skips are reported, never swallowed.
 */
const MIN_SHADOWED_NODES = 12;
const MIN_SHADOWED_CALLS = 4;
const MAX_CANDIDATES = 8;

/** Renumber a mid-write snapshot in memory so `Session.create` accepts it (probe only). */
function contiguousEvents(events) {
  for (let i = 0; i < events.length; i += 1) if (events[i].seq !== i) return events.map((e, i) => ({ ...e, seq: i }));
  return events;
}

/** Close an open tail turn IN MEMORY ONLY (the engine's open-turn guard). */
function closeOpenTurn(events) {
  const endedTurns = new Set(events.filter((event) => event.type === 'turn/end').map((event) => event.data.turn));
  const openTurnStart = [...events].reverse().find((event) => event.type === 'turn/start' && !endedTurns.has(event.data.turn));
  if (openTurnStart === undefined) return { closed: false, turn: undefined };
  const turn = openTurnStart.data.turn;
  const lastStep = events.filter((event) => event.type === 'step/start' && event.data.turn === turn).at(-1)?.data.step ?? 0;
  let seq = events.length;
  let time = events.at(-1).time;
  if (lastStep > 0) {
    events.push({ type: 'step/end', seq: seq, time: ++time, data: { turn, step: lastStep } });
    seq += 1;
  }
  events.push({ type: 'turn/end', seq: seq, time: ++time, data: { turn, reason: { kind: 'completed' } } });
  return { closed: true, turn };
}

/**
 * Cut a log right after the LAST human turn that sits between two checkpoints, so
 * the stretch the base then compacts really holds user messages: the newest tail of
 * a long agent run is usually pure tool traffic, and its checkpoint would pin
 * nothing — which leaves the pin block with nothing to judge. Returns null when no
 * such stretch exists (then the caller judges the tail as it is).
 */
function humanBearingCut(events) {
  const cpSeqs = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint')
    .map((event) => event.seq);
  const humans = userMessages(events);
  for (let i = cpSeqs.length - 2; i >= 0; i -= 1) {
    const between = humans.filter((entry) => entry.seq > cpSeqs[i] && entry.seq < cpSeqs[i + 1]);
    if (between.length === 0) continue;
    const to = between.at(-1).seq;
    if (callsInRange(events, cpSeqs[i], to).length < MIN_SHADOWED_CALLS) continue;
    return { events: events.filter((event) => event.seq <= to).map((event, index) => ({ ...event, seq: index })), from: cpSeqs[i], to };
  }
  return null;
}

/** One runtime load for the probe and for every run. */
let runtimeModules;

async function ensureRuntime() {
  if (runtimeModules === undefined) {
    const runtime = await loadRuntime(entry, { allowUntested: true });
    const require = createRequire(entry);
    const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')).href);
    const { TokenMeter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-token-meter')).href);
    runtimeModules = { Session, TokenMeter, Engine: createEngineClass(runtime) };
  }
  return runtimeModules;
}

/** The host context one Engine needs; `logs` collects everything it says. */
function runContext(logs, TokenMeter, session) {
  return {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(`WARN ${line}`) },
    on: () => {},
    get: () => undefined, // no llm anywhere: a base path that asked a model would throw
    reflect: { provide: () => {} },
    tokenMeter: meterFor(session, TokenMeter),
    sessions: { flush: async () => {} },
  };
}

/** The one config both the probe and every run share, plus the shape under test. */
function sharedConfig(format, thoughtChars) {
  return {
    auto: false,
    retainTokens: 0, // demo-only: makes the whole real surface compactable
    thoughtChars,
    retainLength: DEFAULT_RETAIN_LENGTH, // the shipped cap on kept human text (each pinned user message)
    refLineFormat: format,
    contextMaxRatio: CONTEXT_MAX_RATIO, // owned row key; the WINDOW itself comes from the route
  };
}

async function chooseSessionFile() {
  const skipped = [];
  for (const file of sessionLogCandidates().slice(0, MAX_CANDIDATES)) {
    let probed;
    try {
      const loaded = loadLogEvents(file);
      const events = contiguousEvents(loaded.events.slice(1));
      closeOpenTurn(events); // in memory only, so the engine's open-turn guard passes
      probed = await probeCompactableSurface(events, skipped);
    } catch (error) {
      skipped.push(`${file}: unreadable surface (${error.message})`);
      continue;
    }
    if (probed === undefined) continue; // probeCompactableSurface already named the reason
    console.log(`picked ${file}: committed span shadows ${probed.nodes} node(s), ${probed.calls} tool call(s)`);
    return { file, skipped };
  }
  return undefined;
}

/**
 * The engine's own view of a candidate log: run the real `compactNow` once and
 * read the span the base committed. Null means the log has nothing to compact,
 * so no shape check could say anything about it.
 */
async function probeCompactableSurface(events, skipped) {
  const { Session, TokenMeter, Engine } = await ensureRuntime();
  let session;
  try {
    session = Session.create('ref-formats-e2e-probe', events.map((event) => ({ ...event })));
  } catch (error) {
    skipped.push(`${events === undefined ? '?' : 'probe'}: Session.create refused the snapshot (${error.message})`);
    return undefined;
  }
  const logs = [];
  const engine = new Engine(runContext(logs, TokenMeter, session), sharedConfig('thought', 200));
  const agent = { session, runMaintenance: (job) => job(new AbortController().signal) };
  let result;
  try {
    result = await engine.compactNow(agent, new AbortController().signal);
  } catch (error) {
    skipped.push(`probe: compactNow refused this log (${error.message})`);
    return undefined;
  }
  if (result === null) {
    skipped.push('probe: the base answered "nothing to shadow" — the surface is already inside retention');
    return undefined;
  }
  const span = result.shadowedRange;
  const calls = countToolCalls(events, span.start, span.end);
  if (calls < MIN_SHADOWED_CALLS) {
    skipped.push(`probe: committed span seq ${span.start}–${span.end} carries only ${calls} tool call(s) — too little to judge the shapes`);
    return undefined;
  }
  return { nodes: result.shadowedSeqs.length, calls };
}

/** Tool-call events the compiler walks inside one inclusive seq range. */
function countToolCalls(events, start, end) {
  let n = 0;
  for (const event of events) {
    if (event.seq < start || event.seq > end) continue;
    if (event.type === 'tool/call') n += 1;
  }
  return n;
}

/** Contiguous seqs: re-read a live store a few times, else renumber in memory. */
async function loadContiguousEvents(file) {
  let loaded = loadLogEvents(file);
  let events = loaded.events.slice(1);
  const isContiguous = (list) => {
    for (let i = 0; i < list.length; i += 1) if (list[i].seq !== i) return false;
    return true;
  };
  for (let attempt = 0; !isContiguous(events) && attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    loaded = loadLogEvents(file);
    events = loaded.events.slice(1);
  }
  if (!isContiguous(events)) {
    console.log('(note: log seqs not contiguous after retries; renumbered in memory for this run)');
    events = events.map((event, index) => ({ ...event, seq: index }));
  }
  return { ...loaded, events, header: loaded.events[0] };
}

// ---------------------------------------------------------------- the harness pieces
/**
 * The meter the base needs: one priced node per SURFACE node (in surface order —
 * the base refuses a meter that disagrees with the session) plus the message
 * estimate behind its shrink rule. Pricing is the harness's own heuristic, so
 * these tests never depend on made-up token arithmetic.
 */
function meterFor(session, TokenMeter) {
  const priced = (seq) => {
    const derived = session.deriveEventMessage(session.eventAt(seq));
    return derived === null ? 0 : TokenMeter.prototype.estimateMessage(derived);
  };
  return {
    measure: () => {
      const nodes = session.surface.nodes.map((seq) => ({ seq, tokens: priced(seq), heuristicTokens: priced(seq) }));
      return { totalTokens: nodes.reduce((total, node) => total + node.tokens, 0), nodes };
    },
    estimateMessage: (message) => (message === null ? 0 : TokenMeter.prototype.estimateMessage(message)),
  };
}

async function oneRun(events, format, thoughtChars) {
  const { Session, TokenMeter, Engine } = await ensureRuntime();
  const session = Session.create('ref-formats-e2e', events.map((event) => ({ ...event })));
  const logs = [];
  const ctx = runContext(logs, TokenMeter, session);
  const engine = new Engine(ctx, sharedConfig(format, thoughtChars));
  const agent = { session, runMaintenance: (job) => job(new AbortController().signal) };

  const t0 = Date.now();
  const result = await engine.compactNow(agent, new AbortController().signal);
  return { result, logs, session, ms: Date.now() - t0 };
}

/** The replacement checkpoint message the base wrote into the surface. */
function checkpointMessages(session) {
  const out = [];
  for (const node of session.surface.nodes) {
    const event = session.eventAt(node);
    if (event === undefined || event.type !== 'user/message') continue;
    if (event.data?.source?.kind !== 'compact-checkpoint') continue;
    out.push(event);
  }
  return out;
}

/** Joined text of one message. */
function textOf(message) {
  const content = Array.isArray(message.content) ? message.content : [];
  return content.filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

// ---------------------------------------------------------------- section parsing
const REF_HEADER = '## Session-log references (dropped tool traffic)';
/** A reference header line only OUR compiler emits (heading + `: seq A–B`). */
const OWN_REF_HEADER_LINE = /^## Session-log references \(dropped tool traffic\): seq \d+–\d+$/m;

/** One pinned human-turn line, and only those inside OUR pinned block. */
function pinLines(body) {
  const at = body.indexOf(PINNED_OPEN);
  if (at < 0) return [];
  const out = [];
  for (const line of body.slice(at).split('\n')) {
    // The verbatim recalled entries below the turn lines open with `[kind seq N]`;
    // a recalled checkpoint may itself quote older pin lines, so stop at that point.
    if (/^\[[a-z-]+ seq \d+\]/.test(line)) break;
    if (/^- \[user seq \d+\]/.test(line)) out.push(line);
  }
  return out;
}
const INSTRUCTION_HEADING = '## Session-log instruction';
const FRAME_CLOSE = '</compacted-summary>';

/** Every occurrence of the reference header in a checkpoint text. */
function headerPositions(text) {
  const positions = [];
  for (let i = text.indexOf(REF_HEADER); i >= 0; i = text.indexOf(REF_HEADER, i + REF_HEADER.length)) positions.push(i);
  return positions;
}

/**
 * The run's OWN reference section. This real log already carries OLDER
 * checkpoints of itself — their headers survive inside the surface — so a count
 * is not enough. What decides is position: our body is the newest checkpoint
 * message, so its own section is the LAST header, and it ends at the next
 * `## ` heading (the session-log instruction block) or at the base's frame
 * close tag, whichever comes first.
 */
function ownSection(text) {
  const positions = headerPositions(text);
  if (positions.length === 0) return null;
  const at = positions.at(-1);
  const after = text.slice(at + REF_HEADER.length);
  const nextHeading = after.search(/\n## /);
  const close = after.indexOf(FRAME_CLOSE);
  let end = after.length;
  if (nextHeading >= 0) end = Math.min(end, nextHeading);
  if (close >= 0) end = Math.min(end, close);
  const body = after.slice(0, end).trim();
  const lines = body.split('\n');
  // A ref entry is ONE logical line — but a clipped key argument may keep raw
  // newlines of a multi-line `command`, so an entry's tail can continue on the
  // following physical lines. Fold them back before parsing pointers.
  const refLines = [];
  for (const line of lines) {
    if (/^\s*- /.test(line)) refLines.push(line);
    else if (refLines.length > 0) refLines[refLines.length - 1] += '\n' + line;
  }
  return { lines, refLines };
}

/** Structural tail of one reference line: the call/result seqs it names. */
const TAIL = /→ seq (\d+), result seq (\d+), (\d+(?:\.\d+)? \w+)(, error)?$/;

/** One line's structural pointers: its seq numbers plus the [min,max] span. */
function pointersOfLine(line) {
  const numbers = [];
  const tail = TAIL.exec(line);
  if (tail !== null) {
    numbers.push(Number(tail[1]), Number(tail[2]));
    // The call seq and its result seq are adjacent in practice; the pair is what
    // makes a line "per call", so keep both.
  }
  // The thought pointer sits OUTSIDE the quoted excerpt, so brackets stay out.
  const outside = line.replace(/\[[^\]]*\]/g, '');
  for (const match of outside.matchAll(/\(thought seq (\d+)\)/g)) numbers.unshift(Number(match[1]));
  if (numbers.length === 0) return { numbers: [], range: undefined };
  return { numbers, range: [Math.min(...numbers), Math.max(...numbers)] };
}

/** The collapsed range line the reference budget writes when oldest lines drop. */
const COLLAPSE = /^- (\d+) earlier calls: seq (\d+)–(\d+), restore with recall or recall_search$/;

/**
 * How many `thought` lines continue a run whose governing thought the line above
 * already quoted — counted OFF THE PRINTED SECTION (the pointer outside brackets
 * is what survives folding).
 */
function sharedThoughtRuns(refLines) {
  const pointer = (line) => {
    const m = /\(thought seq (\d+)\)/.exec(line.replace(/\[[^\]]*\]/g, ''));
    return m && m[1];
  };
  let runs = 0;
  for (let i = 1; i < refLines.length; i++) {
    const here = pointer(refLines[i]);
    if (here !== undefined && here === pointer(refLines[i - 1])) runs++;
  }
  return runs;
}

/**
 * How many collapses the `thought` shape MUST render for one span, read off the
 * INPUT events — never off the printed lines, or the check would only agree with
 * itself. Mirrors lib/compiler.mjs toolTraffic: walk the span in order carrying
 * the newest NON-EMPTY reasoning block seen so far as the governing thought (it
 * survives across messages), then count every dropped call whose governing
 * thought is the one the line above already quoted.
 */
function expectedSharedThoughtRuns(events, start, end) {
  let governingSeq;
  let prevThoughtSeq;
  let runs = 0;
  for (const event of events) {
    if (event.seq < start || event.seq > end) continue;
    if (event.type === 'assistant/message') {
      const content = event.data?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block?.type !== 'reasoning') continue;
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        if (text.length > 0) governingSeq = event.seq;
      }
      continue;
    }
    if (event.type !== 'tool/call') continue;
    if (governingSeq !== undefined && governingSeq === prevThoughtSeq) runs += 1;
    prevThoughtSeq = governingSeq;
  }
  return runs;
}

/** Tool-call seqs the compiler would name inside one inclusive range. */
function callsInRange(events, start, end) {
  const seqs = [];
  for (const event of events) {
    if (event.seq < start || event.seq > end) continue;
    if (event.type === 'tool/call') seqs.push(event.seq);
  }
  return seqs;
}

// ---------------------------------------------------------------- the run matrix
const FORMATS = REF_LINE_FORMATS; // ['thought','none']
const THOUGHT_CHARS = [0, 200];

async function assertWholeSpanStable(runs) {
  const first = runs[0];
  for (const run of runs.slice(1)) {
    assert.deepEqual(
      [run.result.shadowedRange.start, run.result.shadowedRange.end, [...run.result.shadowedSeqs]],
      [first.result.shadowedRange.start, first.result.shadowedRange.end, [...first.result.shadowedSeqs]],
      `${run.format} @ ${run.thoughtChars}: same compacted span as every other shape`,
    );
  }
}

test('refLineFormat e2e on the committed sample session log', { skip }, async () => {
  const chosen = await chooseSessionFile();
  assert.ok(chosen !== undefined, 'the fixture log or a live session log exists so a real span can be judged');
  const { file, skipped } = chosen;

  const loaded = await loadContiguousEvents(file);
  const cut = humanBearingCut(loaded.events); // the judged window holds user turns, so the pin block has real work
  const judged = cut === null ? loaded.events : cut.events;
  const closed = closeOpenTurn(judged);
  const events = judged;

  const runs = [];
  for (const format of FORMATS) {
    for (const chars of THOUGHT_CHARS) {
      const out = await oneRun(events, format, chars);
      assert.ok(out.result !== null, `${format} @ ${chars}: compaction ran on the real log`);
      runs.push({
        format,
        thoughtChars: chars,
        session: out.session,
        result: out.result,
        logs: out.logs,
        ms: out.ms,
        text: textOf(checkpointMessages(out.session).at(-1).data),
      });
    }
  }

  // --- the span is the same for every shape -----------------------------------
  await assertWholeSpanStable(runs);
  const span = runs[0].result.shadowedRange;
  const expectedCalls = callsInRange(events, span.start, span.end);
  assert.ok(expectedCalls.length >= MIN_SHADOWED_CALLS, 'the real span shadows real tool traffic');

  // The compiler is the author of the body: no model answered anywhere.
  for (const run of runs) {
    const summaryEvent = run.session.eventAt(run.result.summarySeq).data;
    assert.equal(summaryEvent.provider, ENGINE_PROVIDER, `${run.format} @ ${run.thoughtChars}: our plugin owns the provider slot`);
    assert.equal(summaryEvent.model, ENGINE_MODEL, 'and the model slot — no LLM answered');
  }

  // --- locate each run's own section ------------------------------------------
  console.log(`pin lines per shape: ${runs.map((r) => `${r.format}@${r.thoughtChars}=${pinLines(r.text).length}`).join(' ')}`);
  console.log(`pin seqs (thought@0): ${pinLines(runs[0].text).map((line) => /^- \[user seq (\d+)\]/.exec(line)[1]).join(',')}`);
  for (const run of runs) {
    assert.ok(run.text.includes('<compacted-summary>'), `${run.format}: the base frame still wraps our body`);
    assert.ok(run.text.includes('automatically generated checkpoint'), 'and the preamble is the base\'s own words');
    assert.ok(run.text.includes('## State of work'), 'our state block survived into the window');
    assert.ok(run.text.includes(INSTRUCTION_HEADING), 'and the resume instructions');
    run.section = ownSection(run.text);
    assert.ok(run.section !== null, `${run.format} @ ${run.thoughtChars}: emitted its own reference section`);
    assert.equal(headerPositions(run.text).length, headerPositions(runs.find((r) => r.format === 'none').text).length,
      `${run.format} @ ${run.thoughtChars}: exactly one reference header of its own (both shapes emit a section)`);
    run.pointers = run.section.refLines.map((line) => pointersOfLine(line));
    run.numbers = [...new Set(run.pointers.flatMap((p) => p.numbers))];
    run.intervals = run.pointers.map((p) => p.range).filter(Boolean);
    run.collapse = run.section.lines.map((line) => COLLAPSE.exec(line)).find(Boolean);
  }

  // --- per-shape line grammar -------------------------------------------------
  for (const run of runs) {
    assert.ok(run.section.refLines.length > 0, `${run.format} @ ${run.thoughtChars}: at least one reference line`);
    for (const line of run.section.refLines) {
      if (COLLAPSE.test(line)) continue;
      assert.ok(TAIL.test(line), `${run.format}: a reference line lost its structural tail (${line})`);
    }
    if (run.format === 'none') {
      for (const line of run.section.refLines) {
        assert.ok(!/\(thought seq \d+\)/.test(line), `none: a line names a thought (${line})`);
        assert.ok(!/^\s*- \[/.test(line), `none: a line is labelled by an excerpt (${line})`);
      }
    } else {
      // `thought`: every line whose call had a governing thought carries that
      // pointer outside the brackets; a call no thought drove falls back to the
      // tool's own label, exactly as in the `none` shape.
      const pointer = (line) => {
        const m = /\(thought seq (\d+)\)/.exec(line.replace(/\[[^\]]*\]/g, ''));
        return m && m[1];
      };
      for (let index = 0; index < run.section.refLines.length; index += 1) {
        const line = run.section.refLines[index];
        if (COLLAPSE.test(line)) continue;
        const labelled = pointer(line) !== undefined;
        assert.ok(labelled || /^\s*- \w+/.test(line), `thought: an unlabelled line (${line})`);
        const opensWithExcerpt = /^\s*- \[.*\] \(thought seq/.test(line);
        const opensWithPointer = /^\s*- \(thought seq \d+\)/.test(line);
        if (run.thoughtChars === 0) {
          assert.ok(!/\] \(thought seq \d+\)/.test(line), 'thoughtChars 0: no excerpt may be quoted');
          if (labelled) assert.ok(opensWithPointer, 'thoughtChars 0: the pointer opens the line');
        } else {
          // An excerpt-less labelled line is legal only as the CONTINUATION of a
          // run whose line above already quoted that same thought.
          if (labelled && !opensWithExcerpt) {
            assert.ok(opensWithPointer, `thought @ ${run.thoughtChars}: a malformed label (${line})`);
            const previous = index > 0 ? run.section.refLines[index - 1] : undefined;
            assert.ok(previous !== undefined && pointer(previous) === pointer(line),
              `thought @ ${run.thoughtChars}: a bare thought pointer must continue a run the line above quoted (${line})`);
          }
        }
      }
    }
  }

  // --- shared-thought collapse (counted from the INPUT events) -----------------
  const thoughtRun = runs.find((run) => run.format === 'thought' && run.thoughtChars === 200);
  const expectedCollapsed = expectedSharedThoughtRuns(events, span.start, span.end);
  thoughtRun.collapsed = sharedThoughtRuns(thoughtRun.section.refLines);
  assert.equal(thoughtRun.collapsed, expectedCollapsed,
    'thought: lines that inherit an already-quoted thought collapse to the pointer — counted from the input events');
  for (let i = 1; i < thoughtRun.section.refLines.length; i += 1) {
    assert.notEqual(thoughtRun.section.refLines[i], thoughtRun.section.refLines[i - 1],
      'thought: two adjacent reference lines are byte-identical (the visible duplicate symptom)');
    const quoted = (line) => /^\s*- \[/.test(line);
    const pointer = (line) => {
      const m = /\(thought seq (\d+)\)/.exec(line.replace(/\[[^\]]*\]/g, ''));
      return m && m[1];
    };
    if (pointer(thoughtRun.section.refLines[i]) === pointer(thoughtRun.section.refLines[i - 1]) && pointer(thoughtRun.section.refLines[i]) !== undefined) {
      assert.ok(!(quoted(thoughtRun.section.refLines[i]) && quoted(thoughtRun.section.refLines[i - 1])),
        'thought: one shared thought quotes its excerpt on more than the first line of the run');
    }
  }

  // --- call coverage: every shadowed call stays reachable ---------------------
  for (const run of runs) {
    const named = new Set();
    for (const p of run.pointers) for (const n of p.numbers) named.add(n);
    let collapsedSeqs = new Set();
    if (run.collapse !== undefined) {
      const from = Number(run.collapse[2]);
      const to = Number(run.collapse[3]);
      collapsedSeqs = new Set(expectedCalls.filter((seq) => from <= seq && seq <= to));
    }
    const missing = expectedCalls.filter((seq) => !named.has(seq) && !collapsedSeqs.has(seq));
    if (run.collapse === undefined) {
      assert.ok(missing.length === 0,
        `${run.format} @ ${run.thoughtChars}: ${missing.length} of ${expectedCalls.length} calls in the span have no line naming them: ${missing.slice(0, 8).join(', ')}`);
    } else {
      // Over the section budget the OLDEST lines drop first, and the collapse
      // line must name exactly their seq range — never a hole with newer calls
      // still pointed at.
      const kept = expectedCalls.filter((seq) => named.has(seq));
      const newestDropped = Number(run.collapse[3]);
      for (const seq of missing) {
        assert.ok(seq <= newestDropped,
          `${run.format}: call seq ${seq} lost its line while a NEWER call (${kept.at(0)}) kept one — trimming is oldest-first`);
      }
    }
    run.coverage = `${expectedCalls.length - missing.length}/${expectedCalls.length}`;
  }

  // --- every numeric pointer resolves through recall --------------------------
  for (const run of runs) {
    for (const n of run.numbers) {
      let restored;
      try {
        restored = recall(run.session, { seq: n }, { maxChars: 10_000 });
      } catch (error) {
        assert.fail(`pointer seq ${n} in ${run.format} @ ${run.thoughtChars} is not restorable: ${error.message}`);
      }
      assert.ok(typeof restored.text === 'string', `recall of seq ${n} returned text`);
    }
  }

  // --- determinism: recompiling the same span right now answers identically ---
  for (const run of runs) {
    const { text: again } = buildCheckpoint(run.session, span.start, span.end, {
      thoughtChars: run.thoughtChars,
      refLineFormat: run.format,
    });
    assert.ok(run.text.includes(again), `${run.format} @ ${run.thoughtChars}: the committed body is byte-for-byte our compiler's own output`);
  }

  // --- pins stay untouched (this e2e pins nothing) ----------------------------
  for (const run of runs) {
    assert.deepEqual([...pinsFor(run.session)], [], 'the pinned map stays empty when nothing was recalled');
  }

  // --- the blocks the window must NEVER lose ----------------------------------
  // A human user message is the only thing that carries the request itself, so
  // each one in the span keeps its own pinned line (never elided); the runtime
  // context and skill catalog survive even when their injection lies OUTSIDE the
  // compacted range (then the compiler carries the newest copy back). Both are
  // judged on the real log, off the INPUT events — not off the printed body.
  const spanHumans = humanTurns(runs[0].session, (seq) => seq >= span.start && seq <= span.end);
  // Human turns an EARLIER compaction already shadowed are no less requests: the
  // pin block must name them too (clipped to retainLength, restorable by recall).
  // Turns older than this span but never shadowed are still in the live window, so
  // re-pinning them here would duplicate a message — they stay out of the count.
  const olderHumans = shadowedHumanEntries(runs[0].session, span.start);
  const expectedPins = [...new Set([...olderHumans.map((entry) => entry.seq), ...spanHumans.map((entry) => entry.seq)])];
  console.log(`pin block source: ${spanHumans.length} human turns inside the span + ${olderHumans.length} shadowed by earlier compactions (oldest seq ${olderHumans.length ? olderHumans[0].seq : '-'}) — expected pin seqs: ${expectedPins.join(',')}`);
  const kindsInLog = new Set();
  for (const event of events) {
    const kind = event.data?.source?.kind;
    if (kind === 'runtime-context' || kind === 'skill-catalog') kindsInLog.add(kind);
  }
  for (const run of runs) {
    const pinnedLines = pinLines(run.text);
    assert.equal(pinnedLines.length, expectedPins.length,
      `${run.format} @ ${run.thoughtChars}: one pinned line per human turn of the session (older spans included)`);
    for (const seq of expectedPins) {
      assert.ok(pinnedLines.some((line) => line.startsWith(`- [user seq ${seq}]`)),
        `${run.format} @ ${run.thoughtChars}: the human turn at seq ${seq} lost its pinned line`);
    }
    for (const line of pinnedLines) {
      // The entry is JSON-quoted, so match its escapes and anchor at the line end:
      // a greedy capture would run past this entry into the next one's pointer text.
      const clip = /^- \[user seq (\d+)\] "((?:[^"\\]|\\.)*)" — restore with recall \{"seq": (\d+)\}$/.exec(line);
      if (clip === null) continue; // pointer-only line: the pinned budget was full
      const kept = JSON.parse(`"${clip[2]}"`); // the entry is JSON-quoted, so decode before counting
      assert.ok([...kept].length <= DEFAULT_RETAIN_LENGTH,
        `retainLength ${DEFAULT_RETAIN_LENGTH}: a pinned clip is longer (${clip[2]})`);
    }
    for (const kind of kindsInLog) {
      assert.ok(run.text.includes(`[${kind} seq`),
        `${run.format} @ ${run.thoughtChars}: the ${kind} block survived the compaction`);
    }
  }

  // --- where the cost of a shape must be monotonic ------------------------------
  // Bytes are monotone ALONG the knob, never ACROSS formats: a `thought` label is
  // `(thought seq N)` while a `none` label carries the tool's own name and key
  // argument, and either can be the longer one. What must hold is (a) raising
  // `thoughtChars` never removes content — unless the section budget folded
  // older lines, where it legitimately can — and (b) at equal knob settings the
  // `thought` shape points at everything `none` does, plus its thought pointers.
  for (const format of FORMATS) {
    const cheap = runs.find((run) => run.format === format && run.thoughtChars === 0);
    const labelled = runs.find((run) => run.format === format && run.thoughtChars === 200);
    if (cheap.collapse === undefined && labelled.collapse === undefined) {
      assert.ok(Buffer.byteLength(labelled.text) >= Buffer.byteLength(cheap.text),
        `${format}: raising thoughtChars to 200 never shrinks the body`);
    } else {
      console.log(`(note: ${format} hit the reference-section budget; byte monotonicity not asserted)`);
    }
    for (const chars of THOUGHT_CHARS) {
      const ours = runs.find((run) => run.format === format && run.thoughtChars === chars);
      const lean = runs.find((run) => run.format === 'none' && run.thoughtChars === chars);
      // Same escape as the byte rule above: once the reference-section budget folds
      // older lines, the folded seqs are legitimately no longer named one by one.
      if (ours.collapse !== undefined || lean.collapse !== undefined) {
        console.log(`(note: ${format} @ ${chars} hit the reference-section budget; seq coverage not asserted)`);
        continue;
      }
      const lost = lean.numbers.filter((n) => !ours.numbers.includes(n));
      assert.ok(lost.length === 0,
        `${format} @ ${chars}: 'none' names seq(s) this shape drops (${lost.slice(0, 8).join(', ')})`);
    }
  }
  const thoughtZero = runs.find((run) => run.format === 'thought' && run.thoughtChars === 0);
  const noneZero = runs.find((run) => run.format === 'none' && run.thoughtChars === 0);
  if (thoughtZero.collapse !== undefined || noneZero.collapse !== undefined) {
    console.log('(note: a shape hit the reference-section budget; coverage counts not compared across formats)');
  } else {
    assert.ok(thoughtZero.numbers.length >= noneZero.numbers.length,
      'thought: names at least as many seqs as none (its thought pointers are extra)');
  }

  // --- save the testing result into the test folder ----------------------------
  removeStaleGeneratedFiles(OUT_DIR);
  mkdirSync(CKPT_DIR, { recursive: true });
  const md = [];
  md.push('# refLineFormat e2e — committed sample session log');
  md.push('');
  md.push(`- input log: \`${file.replace(/\\/g, '\\')}\``);
  md.push(
    file === FIXTURE
      ? '- source: the committed fixture under `test/fixtures` — the same frozen sample every run'
      : existsSync(FIXTURE)
        ? '- source: an explicit log given as argv[2] (the fixture was NOT the input)'
        : '- source: live-scan fallback — no fixture checked out, so the newest compactable session log won',
  );
  if (skipped.length > 0) {
    md.push('- other logs skipped because this run could not compact them:');
    for (const reason of skipped) md.push(`  - ${reason}`);
  } else {
    md.push('- other logs skipped: none');
  }
  md.push(`- events: ${events.length} (compressed ${(loaded.rawBytes / 1024).toFixed(1)} KiB / ${loaded.plainBytes / 1024 | 0} KiB JSONL, ${loaded.frames} zstd frames)`);
  md.push(`- window used for judging: ${cut === null ? 'the log as it is (no checkpoint-bounded stretch holds a human turn)' : `cut after seq ${cut.to} — the newest checkpoint-bounded stretch that holds human turns, so the pin block gets real work`}`);
  md.push(`- open tail turn closed in memory: ${closed.closed ? `yes (turn ${closed.turn})` : 'no'}`);
  md.push(`- session id: ${loaded.header?.id ?? '?'} · preset of that log: ${loaded.header?.agentPreset ?? '?'}`);
  md.push(`- engine: ${ENGINE_PROVIDER} / ${ENGINE_MODEL} (no model call anywhere)`);
  md.push(`- shared config: \`auto: false\`, \`retainTokens: 0\` (test-only: makes the whole real surface compactable)`);
  md.push(`- committed span: seq ${span.start}–${span.end} (${runs[0].result.shadowedSeqs.length} surface nodes, ${expectedCalls.length} tool calls)`);
  md.push(`- pinned human turns: ${spanHumans.length} inside the span + ${olderHumans.length} older ones an earlier compaction already shadowed (re-read off the log) = ${expectedPins.length} lines, every one kept at any output budget, clipped to retainLength=${DEFAULT_RETAIN_LENGTH} and restorable by recall`);
  md.push(`- context kinds this log injects: ${[...kindsInLog].sort().map((kind) => `\`${kind}\``).join(', ') || 'none'} — every one appears in every body (carried back when its injection lies outside the span)`);
  md.push(`- reference-section budget: \`contextMaxRatio\` ${CONTEXT_MAX_RATIO} × the MESSAGE BUDGET the route leaves its window (window − reserved output; the raw window stands in when the route names no budget — these direct runs name none), else the ${REFERENCES_BLOCK_BYTES}-byte fallback — the section is sized from that share, NOT a fixed block; only the OLDEST lines collapse into one range line, and only when that share cannot hold every line`);
  md.push('');
  md.push('| refLineFormat | thoughtChars | checkpoint bytes | shadowed tokens | ref lines | pointers | call coverage | collapses | ms |');
  md.push('|---|---|---|---|---|---|---|---|---|');
  for (const run of runs) {
    const name = `${run.format}-thoughtChars${run.thoughtChars}`;
    writeFileSync(join(CKPT_DIR, `${name}.txt`), run.text, 'utf8');
    md.push(
      `| ${run.format} | ${run.thoughtChars} | ${Buffer.byteLength(run.text)} | ${run.result.shadowedTokenCount} | ` +
      `${run.section.refLines.length} | ${run.numbers.length} | ${run.coverage ?? 'n/a'} | ` +
      `${run === thoughtRun ? expectedCollapsed : (run.collapse === undefined ? 0 : Number(run.collapse[1]))} | ${run.ms} |`,
    );
  }
  md.push('');
  md.push(`## Shared-thought collapse on the \`thought\` shape`);
  md.push('');
  md.push(`The span's input events demand ${expectedCollapsed} collapse(s): a call whose governing thought the line above already quoted keeps only its pointer, so the same prose never repeats while every seq stays recallable.`);
  md.push('');
  md.push('## Reference section of every run (first lines)');
  for (const run of runs) {
    const name = `${run.format}-thoughtChars${run.thoughtChars}`;
    md.push('');
    md.push(`### ${name}`);
    md.push('```text');
    for (const line of run.section.lines.slice(0, 6)) md.push(line);
    md.push('```');
    md.push(`Full checkpoint: [${name}](${CKPT_DIR.replace(/\\/g, '\\')}\\${name}.txt)`);
  }
  // --- the SAME span at two OUTPUT budgets, written side by side ---------------
  // Reading is unlimited in both: the index is collected off the log first and deduped
  // by call seq. These two runs differ ONLY in what the output stage may print, so the
  // pair shows the fold line for what it is — a coarsening of rows the budget cannot
  // hold, never a loss. The "unlimited" variant states that as a share big enough to
  // hold every row (`contextMaxRatio` is capped at 1, so it is the WINDOW that carries
  // "no cap": window × ratio must already exceed the whole index).
  md.push('## The same span at two output budgets');
  md.push('');
  md.push('| variant | ref budget (bytes) | rows named | rows folded | checkpoint bytes |');
  md.push('|---|---|---|---|---|');
  const budgetVariants = [];
  for (const shape of [
    { label: 'budget-64k-window', windowTokens: CONTEXT_WINDOW_TOKENS, ratio: CONTEXT_MAX_RATIO },
    { label: 'budget-unlimited', windowTokens: 10_000_000, ratio: 1 },
  ]) {
    const compiled = buildCheckpoint(runs[0].session, span.start, span.end, {
      thoughtChars: 200,
      refLineFormat: 'thought',
      retainLength: DEFAULT_RETAIN_LENGTH,
      contextWindowTokens: shape.windowTokens,
      contextMaxRatio: shape.ratio,
    });
    budgetVariants.push({ label: shape.label, stats: compiled.stats, text: compiled.text });
    writeFileSync(join(CKPT_DIR, `${shape.label}.txt`), compiled.text, 'utf8');
  }
  const [sixtyFour, unlimited] = budgetVariants;
  assert.ok(sixtyFour.stats.refsDropped > 0, 'a 64K window at the shipped share cannot hold every row — the oldest fold');
  assert.equal(unlimited.stats.refsDropped, 0, 'with room to spare nothing folds: every indexed call gets its own line');
  assert.ok(!/earlier calls: seq \d+–\d+/.test(unlimited.text), 'the unlimited output carries no fold line at all');
  assert.equal(sixtyFour.stats.carriedRefs, unlimited.stats.carriedRefs,
    'both budgets inherit the SAME older rows — the index is collected before any budget applies');
  const namedCalls = (variant) => variant.stats.refs - (/earlier calls: seq \d+–\d+/.test(variant.text) ? 1 : 0) + variant.stats.refsDropped;
  assert.equal(namedCalls(sixtyFour), namedCalls(unlimited),
    'both budgets name the SAME set of calls — the budget coarsens the listing, never the index');
  for (const variant of budgetVariants) {
    const pins = pinLines(variant.text);
    assert.equal(pins.length, expectedPins.length,
      `${variant.label}: every human turn survives at this output budget — a size cap never drops a request`);
  }
  for (const variant of budgetVariants) {
    md.push(
      `| ${variant.label} | ${variant.stats.referenceBytes} | ${variant.stats.refs} | ${variant.stats.refsDropped} | ${variant.stats.bytes} |`,
    );
  }
  md.push('');
  for (const variant of budgetVariants) {
    const firstLines = variant.text.slice(variant.text.indexOf(REF_HEADER)).split('\n').slice(0, 5);
    md.push('');
    md.push(`### ${variant.label}`);
    md.push('```text');
    for (const line of firstLines) md.push(line);
    md.push('```');
    md.push(`Full checkpoint: [${variant.label}](${CKPT_DIR.replace(/\\/g, '\\')}\\${variant.label}.txt)`);
  }
  writeFileSync(join(OUT_DIR, 'ref-formats-e2e-report.md'), md.join('\n') + '\n', 'utf8');

  console.log(`e2e refLineFormat run over ${runs.length} configurations on ${file}`);
  for (const variant of budgetVariants) {
    console.log(`${variant.label}: refs ${variant.stats.refs} named, ${variant.stats.refsDropped} folded, budget ${variant.stats.referenceBytes} B, body ${variant.stats.bytes} B`);
  }
  console.log(`committed span: seq ${span.start}–${span.end}, ${runs[0].result.shadowedSeqs.length} nodes, ${expectedCalls.length} tool calls`);
  for (const run of runs) {
    console.log(`${run.format}@${run.thoughtChars}: checkpoint ${Buffer.byteLength(run.text)} B, refs ${run.section.refLines.length} lines, pointers ${run.numbers.length}, coverage ${run.coverage ?? 'n/a'}, ${run.ms} ms`);
  }
  console.log(`report: ${join(OUT_DIR, 'ref-formats-e2e-report.md')} (+ checkpoints in ${CKPT_DIR})`);
});

// ---------------------------------------------------------------- cross-span accumulation
/**
 * A second real-log run — this time over a window that HOLDS REAL HUMAN TURNS, so
 * the pin block gets judged on live data (test 1's span was pure agent traffic and
 * its pin assertions were vacuous), and over one that OPENS with an earlier
 * checkpoint message, so the cross-span index gets judged too: when that earlier
 * body is ours, its reference lines must be re-published ahead of this span's (the
 * index accumulates); when another backend wrote it — an LLM summary whose prose
 * merely NAMES our headings — nothing of our line shape may be invented from it.
 * Which case a log is in gets reported, never assumed.
 *
 * The window is built by cutting the fixture right after the last human turn that
 * sits between two checkpoints; the base then compacts exactly that stretch, and
 * nothing here depends on seq numbers hardcoded for one log.
 *
 * Saved separately so this run never fights test 1's report writer:
 *   test/out/cumulative-span-e2e-report.md
 *   test/out/checkpoints/cumulative-span-thought-thoughtChars200.txt
 */
test('cross-span index safety and the pin block on a real window with human turns', { skip }, async () => {
  const chosen = await chooseSessionFile();
  assert.ok(chosen !== undefined, 'a session log exists so a real span can be judged');
  const { file } = chosen;

  const loaded = await loadContiguousEvents(file);
  const events = loaded.events;

  // Checkpoint messages in this log (any backend): they mark where the base starts
  // a new span, so a window between two of them is a window the base will compact.
  const cpSeqs = events.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint')
    .map((event) => event.seq);
  assert.ok(cpSeqs.length >= 2, 'the log holds at least two checkpoints, so one window can open with an earlier one');

  // Cut after the LAST human turn that still sits before the next own checkpoint.
  const humans = userMessages(events);
  const windows = [];
  for (let i = 0; i + 1 < cpSeqs.length; i += 1) {
    const between = humans.filter((entry) => entry.seq > cpSeqs[i] && entry.seq < cpSeqs[i + 1]);
    if (between.length >= 2) windows.push({ from: cpSeqs[i], to: between.at(-1).seq, humans: between });
  }
  const usable = windows.find((window) => callsInRange(events, window.from, window.to).length >= MIN_SHADOWED_CALLS);
  assert.ok(usable !== undefined, 'the log holds a stretch that starts at one of our checkpoints and ends with real human turns');
  const window = usable;

  const truncated = events.filter((event) => event.seq <= window.to).map((event, index) => ({ ...event, seq: index }));
  const closed = closeOpenTurn(truncated);
  const out = await oneRun(truncated, 'thought', 200);
  assert.ok(out.result !== null, 'the truncated log compacted');
  const span = out.result.shadowedRange;

  const text = textOf(checkpointMessages(out.session).at(-1).data);
  assert.ok(text.includes(REF_HEADER), 'the body indexes its traffic');

  // The inherited lines: seqs BELOW this span's start can only come from carry.
  const cps = truncated.filter((event) => event.type === 'user/message' && event.data?.source?.kind === 'compact-checkpoint')
    .map((event) => ({ seq: event.seq, ourHeader: OWN_REF_HEADER_LINE.test(textOf(event.data)) }));
  const oursHere = cps.filter((entry) => entry.ourHeader);
  console.log(`diag: span=${span.start}-${span.end} cps=${JSON.stringify(cps)} ofOurs=${oursHere.length}`);
  const units = carriedReferences(truncated.filter((event) => event.seq >= span.start && event.seq <= span.end));
  if (oursHere.length === 0) {
    // The prior checkpoints in this stretch were written by ANOTHER backend — an
    // LLM summary whose prose happens to name our headings. Nothing of our line
    // shape may be invented from it, and the run must still index its own span.
    assert.deepEqual(units, [], 'a summary some other backend wrote is not re-indexed, even when its prose quotes our headings');
  } else {
    assert.ok(units.length > 0, 'the checkpoint this window opens with contributes its own reference lines');
    const olderUnits = units.filter((entry) => entry.callSeq < span.start);
    assert.ok(olderUnits.length > 0, 'the carried lines name traffic from BEFORE this span — the index is cumulative');
    for (const entry of olderUnits) {
      assert.ok(text.includes(entry.line), `an inherited line for seq ${entry.callSeq} vanished instead of leading the section`);
    }
  }

  // Pin block: one line per human turn of the WHOLE session — the span's own turns
  // plus every turn an earlier compaction already shadowed, re-read off the log.
  const humansInSpan = humanTurns(out.session, (seq) => seq >= span.start && seq <= span.end);
  assert.ok(humansInSpan.length >= 1, 'this window really holds human turns, so the pin block has something to keep');
  const olderHumansCum = shadowedHumanEntries(out.session, span.start);
  const expectedPinsCum = [...new Set([...humansInSpan.map((entry) => entry.seq), ...olderHumansCum.map((entry) => entry.seq)])];
  const pinnedLines = pinLines(text);
  assert.equal(pinnedLines.length, expectedPinsCum.length,
    `one pinned line per human turn of the session — ${humansInSpan.length} in this span + ${olderHumansCum.length} older ones shadowed by earlier compactions (none elided)`);
  for (const seq of expectedPinsCum) {
    assert.ok(pinnedLines.some((line) => line.startsWith(`- [user seq ${seq}]`)),
      `the human turn at seq ${seq} lost its pinned line`);
  }
  for (const line of pinnedLines) {
    const clip = /^- \[user seq (\d+)\] "((?:[^"\\]|\\.)*)" — restore with recall \{"seq": (\d+)\}$/.exec(line);
    if (clip === null) continue; // pointer-only line: the pinned budget was full
    const kept = JSON.parse(`"${clip[2]}"`); // the entry is JSON-quoted, so decode before counting
    assert.ok([...kept].length <= DEFAULT_RETAIN_LENGTH,
      `retainLength ${DEFAULT_RETAIN_LENGTH}: a pinned clip is longer (${clip[2]})`);
  }

  const { stats } = buildCheckpoint(out.session, span.start, span.end, { thoughtChars: 200, refLineFormat: 'thought' });
  const section = ownSection(text);
  assert.ok(section !== null, 'the run emitted its own reference section');
  const bodyNumbers = new Set(section.refLines.flatMap((line) => pointersOfLine(line).numbers));
  assert.ok(bodyNumbers.size > 0, 'the section names seqs');
  assert.ok(stats.refs >= section.refLines.length - 1, 'stats name the lines the section printed');

  // The authoritative carry source is the LOG, not whatever replaced older traffic:
  // the host-owned `compaction/summary` brackets name every seq range an earlier
  // compaction shadowed, and the append-only log still holds those calls. So a
  // checkpoint some OTHER backend wrote no longer limits what this session indexes.
  const logUnits = shadowedCallEntries(out.session, span.start);
  assert.ok(logUnits.every((entry) => entry.call.seq < span.start), 'the log source names only traffic OLDER than the span being compacted');
  const distinctLog = new Set(logUnits.map((entry) => entry.call.seq));
  assert.equal(distinctLog.size, logUnits.length, 'a call inside two overlapping shadow ranges is still indexed once');
  if (logUnits.length > 0) {
    const oldestFromLog = Math.min(...distinctLog);
    const header = /^## Session-log references[^\n]*seq (\d+)–(\d+)/m.exec(text);
    assert.ok(header !== null, 'the run printed its reference section');
    assert.ok(Number(header[1]) <= oldestFromLog, `the section starts at or before the OLDEST shadowed call (${oldestFromLog})`);
    assert.ok(oldestFromLog < span.start, 'the index reaches traffic from BEFORE this span — it is cumulative across the whole session');
  }
  assert.ok(stats.carriedRefs >= distinctLog.size, 'stats name every shadowed call the log source found');

  const md = [];
  md.push('# cross-span safety — real log, a window that holds real human turns');
  md.push('');
  md.push('');
  md.push(`- input log: \`${file.replace(/\\/g, '\\')}\``);
  md.push(`- events used: ${truncated.length} of ${events.length} (cut after the human turn at seq ${window.to})`);
  md.push(`- open tail turn closed in memory: ${closed.closed ? `yes (turn ${closed.turn})` : 'no'}`);
  md.push(`- committed span: seq ${span.start}–${span.end} (${out.result.shadowedSeqs.length} nodes, ${callsInRange(truncated, span.start, span.end)} tool calls)`);
  md.push(`- pinned human turns: ${humansInSpan.length} inside the span + ${olderHumansCum.length} older ones an earlier compaction shadowed (re-read off the log) = ${expectedPinsCum.length} lines, every one kept at any output budget (clipped to retainLength=${DEFAULT_RETAIN_LENGTH}, restorable by recall)`);
  md.push(`- shadowed calls the LOG re-indexed for older spans: ${distinctLog.size} (stats carriedRefs ${stats.carriedRefs}) of ${section.refLines.length} printed — ` +
    (oursHere.length === 0
      ? 'every prior checkpoint in this window was written by ANOTHER backend, yet its traffic is still indexed because the log, not that body, is the source'
      : `${oursHere.length} of our own checkpoints opened this window`));
  md.push(`- oldest seq still named in the section: ${Math.min(...bodyNumbers)} (span starts at ${span.start})`);
  md.push('');
  md.push('## Reference section of the run (first lines)');
  md.push('');
  md.push('```text');
  for (const line of section.lines.slice(0, 12)) md.push(line);
  md.push('```');
  writeFileSync(join(OUT_DIR, 'cumulative-span-e2e-report.md'), md.join('\n') + '\n', 'utf8');
  writeFileSync(join(CKPT_DIR, 'cumulative-span-thought-thoughtChars200.txt'), text, 'utf8');

  console.log(`cumulative e2e: span seq ${span.start}–${span.end}, ${distinctLog.size} shadowed calls re-indexed from the log (${stats.carriedRefs} inherited lines), oldest named seq ${Math.min(...bodyNumbers)}`);
  console.log(`report: ${join(OUT_DIR, 'cumulative-span-e2e-report.md')}`);
});
