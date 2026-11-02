/**
 * Model-facing `recall` / `recall_search` tools and the human-facing
 * `/recall` and `/fastcompact` commands.
 *
 * Tool names are configurable (`recallToolName`, `searchToolName`) because
 * `search` is a generic name that another plugin may already register. The
 * commands report what THIS engine did — its own last compaction and the
 * reference-line shape in force — not the base package's internals.
 *
 * @module dsh-fast-compact/tools
 */

import { recall, search, normalizeRecallRequest, RecallError, SEARCH_KINDS } from './recall.mjs';
import { pin } from './pins.mjs';
import { toolResultOfEvent } from './messages.mjs';
import { formatKb } from './measure.mjs';
import { REF_LINE_FORMATS } from './config.mjs';
import { groupInt, shareOf } from './compiler.mjs';

/** Render token counts the way the user reads them: grouped, as a share of the
 * route's WINDOW — the ONE basis every number in this plugin speaks (the gate is
 * `ceil(W * thresholdRatio)`, the checkpoint ceiling is `contextMaxRatio` of W).
 * A missing denominator (capacity unknown for this route) simply drops that
 * percentage rather than inventing one.
 * @param {number} value - tokens to phrase.
 * @param {object} stats - carries `contextWindow` when known.
 * @returns {string} - e.g. ' (70.0% of the window)' ('' when the window is unknown).
 */
function usagePhrase(value, stats) {
  if (stats === undefined || stats === null) return '';
  const windowShare = shareOf(value, stats.contextWindow);
  return windowShare === '' ? '' : ` (${windowShare} of the window)`;
}

export const DEFAULT_TOOL_NAMES = Object.freeze({ recall: 'recall', search: 'recall_search' });

const OUTPUT = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
};

/**
 * Pin what the model recalled so the next compaction keeps it at full length.
 * A tool result is shown on its CALL's reference line, so the answered call
 * seq is pinned as well.
 */
function pinRecalled(session, seqs) {
  const all = new Set(seqs);
  for (const seq of seqs) {
    const event = session.eventAt(seq);
    if (event?.type !== 'tool/result') continue;
    const callId = toolResultOfEvent(event)?.toolCallId;
    for (let back = seq - 1; back >= 0 && back >= seq - 400; back -= 1) {
      const candidate = session.eventAt(back);
      if (candidate?.type === 'assistant/message' && (candidate.data?.message?.content ?? []).some((block) => block?.type === 'tool-call' && block.id === callId)) {
        all.add(back);
        break;
      }
    }
  }
  pin(session, all);
}

/** Transcript label for a recall call, after the same placeholder handling as the tool. */
export function recallCallLabel(args) {
  let request;
  try {
    ({ request } = normalizeRecallRequest(args));
  } catch {
    return 'invalid request';
  }
  const target = request.result !== undefined ? `result ${request.result}` : request.seq !== undefined ? `seq ${request.seq}` : `range ${request.range}`;
  return `${target}${request.grep ? ` grep ${request.grep}` : ''}`;
}

/**
 * Build the two tool definitions.
 * @param runtime - { defineTool, HarnessError }
 * @param {{ maxRecallChars: number, maxSearchHits: number }} budgets
 * @param {{ recall: string, search: string }} names
 */
export function defineRecallTools(runtime, budgets, names) {
  const { defineTool, HarnessError } = runtime;
  const toHarness = (error) => (error instanceof RecallError ? new HarnessError(error.message, error.code, { cause: error }) : error);
  const sessionOf = (exec) => {
    const session = exec?.agent?.session;
    if (session === undefined) throw new HarnessError('recall requires a calling agent with a session', 'RECALL_AGENT_REQUIRED');
    return session;
  };

  const recallTool = defineTool({
    name: names.recall,
    description: [
      'Restore the exact original content of an earlier entry in THIS conversation from the append-only session log.',
      'Call it before acting on anything a compaction checkpoint shows cut, elided, or only as a (seq N) pointer — never guess cut content.',
      'Set one of seq, result, or range, plus only the optional parameters you need; omit the rest.',
      'Long output is paginated: call again with the offset it reports.',
    ].join(' '),
    parameters: {
      seq: { type: 'integer', description: 'Seq of one log entry, e.g. 1234.' },
      result: { type: 'integer', description: 'Seq of a tool call or tool result; returns that call\'s original output. Use instead of seq.' },
      range: { type: 'string', description: 'Inclusive seq range such as "120-140" (max 200 seqs). Use instead of seq.' },
      grep: { type: 'string', description: 'Optional case-insensitive regex; return only matching lines (numbered) plus context.' },
      context: { type: 'integer', description: 'Optional lines of context around each grep match (0-20, default 2).' },
      head: { type: 'integer', description: 'Optional: return only the first N characters.' },
      tail: { type: 'integer', description: 'Optional: return only the last N characters (with head: both ends).' },
      offset: { type: 'integer', description: 'Optional character offset for the next page, as reported by a previous call.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      try {
        const session = sessionOf(exec);
        const recalled = recall(session, args, { maxChars: budgets.maxRecallChars });
        pinRecalled(session, recalled.seqs);
        return recalled.text;
      } catch (error) {
        throw toHarness(error);
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Recall history',
      kind: 'read',
      rawInput: recallCallLabel(args),
    }),
  });

  const searchTool = defineTool({
    name: names.search,
    description: [
      'Search THIS conversation\'s full session log, including history replaced by compaction checkpoints.',
      'Returns matching entries newest first with their (seq N) pointers; restore any hit with the recall tool.',
      'Case-insensitive substring match by default; set regex=true for a regular expression.',
      `Filter with kind (${SEARCH_KINDS.join(', ')}) and since/until (inclusive seqs).`,
    ].join(' '),
    parameters: {
      query: { type: 'string', required: true, description: 'Text (or regex) to look for.' },
      regex: { type: 'boolean', description: 'Treat query as a regular expression.' },
      kind: { type: 'string', enum: [...SEARCH_KINDS], description: 'Only entries of this kind. "user" = what the human wrote; "error" = failed tool results.' },
      since: { type: 'integer', description: 'Only entries at or after this seq.' },
      until: { type: 'integer', description: 'Only entries at or before this seq.' },
    },
    output: OUTPUT,
    isConcurrencySafe: () => true,
    execute(args, exec) {
      try {
        return search(sessionOf(exec), args, { maxHits: budgets.maxSearchHits }).text;
      } catch (error) {
        throw toHarness(error);
      }
    },
    presentCall: (args) => ({ card: 'generic', title: 'Search history', kind: 'read', rawInput: args.query }),
  });

  return [recallTool, searchTool];
}

/** Characters of recalled text shown in the transcript by /recall. */
const COMMAND_RECALL_CHARS = 20_000;

/** Parse `/recall` input: `123`, `120-140`, or `result 123`. */
export function parseRecallCommand(raw) {
  const text = String(raw ?? '').trim();
  let match = /^result\s+(\d+)$/i.exec(text);
  if (match) return { result: Number(match[1]) };
  match = /^(\d+)\s*(?:-|–|\.\.)\s*(\d+)$/.exec(text);
  if (match) return { range: `${match[1]}-${match[2]}` };
  match = /^(?:seq\s+)?(\d+)$/i.exec(text);
  if (match) return { seq: Number(match[1]) };
  return null;
}

/** One readable shape: `thought (labels 200 chars)` / `none (no labels)` / `thought (pointers only)`. */
function describeShape(shape) {
  if (shape.refLineFormat === 'none') return 'none (no reference lines emitted)';
  return shape.thoughtChars <= 0
    ? 'thought (pointers only — no excerpts)'
    : `thought (labels ${shape.thoughtChars} chars)`;
}

/** The shapes list for the help output, one line per configured format name. */
const REF_LINE_FORMAT_HELP = {
  thought: 'one line per dropped call, labelled by the thought that drove it',
  none: 'emit no reference section at all (the traffic is still dropped)',
};

/** The shapes list for the help output, one line per configured format name. */
function refLineFormatList() {
  const lines = [];
  for (const format of REF_LINE_FORMATS) lines.push(`  ${format} — ${REF_LINE_FORMAT_HELP[format] ?? ''}`.trimEnd());
  return lines.join('\n');
}

/** Usage line, optionally led by what went wrong. */
function formatUsage(message) {
  const usage = 'Usage: /fastcompact format [<thought|none> [chars <n>] | chars <n> | reset]';
  return message ? `${message}\n${usage}` : usage;
}

/** Confirmation line after a shape change (what it is now and when it applies). */
function shapeSetText(shape) {
  return `Reference lines for this session now use ${describeShape(shape)}. `
    + 'Takes effect from the NEXT compaction; checkpoints already written keep their own shape. '
    + 'Runtime-only: restarting dsh falls back to the configured preset.';
}

/**
 * `/fastcompact format …` — report or change the reference-line shape of ONE
 * session from here on. `rest` are the tokens after the word `format`.
 * @returns {{ kind: 'success' | 'error', text: string }}
 */
function formatCommand(engine, session, rest) {
  if (typeof engine?.setShape !== 'function' || typeof engine?.currentShape !== 'function') {
    return { kind: 'error', text: 'This compaction engine has no runtime reference-line shape to change.' };
  }
  if (rest.length === 0) {
    return {
      kind: 'success',
      text: [
        `Reference lines now: ${describeShape(engine.currentShape(session))}.`,
        'Choose a shape; it applies to the next compaction of this session:',
        refLineFormatList(),
        formatUsage(''),
        'Example: /fastcompact format thought chars 400',
      ].join('\n'),
    };
  }
  const head = rest[0].toLowerCase();
  try {
    if (head === 'reset') {
      if (rest.length > 1) return { kind: 'error', text: formatUsage('reset takes no other argument.') };
      const shape = engine.setShape(session, { refLineFormat: null, thoughtChars: null });
      return { kind: 'success', text: `Overrides cleared — this session is back to ${describeShape(shape)}.` };
    }
    if (head === 'chars' || head === 'label') {
      if (rest.length !== 2) return { kind: 'error', text: formatUsage('chars takes exactly one non-negative integer.') };
      const chars = Number(rest[1]);
      if (!Number.isInteger(chars) || chars < 0) return { kind: 'error', text: formatUsage(`chars "${rest[1]}" is not a non-negative integer.`) };
      return { kind: 'success', text: shapeSetText(engine.setShape(session, { thoughtChars: chars })) };
    }
    if (!REF_LINE_FORMATS.includes(head)) {
      return { kind: 'error', text: `${formatUsage(`Unknown format "${rest[0]}".`)}\nChoose one of: ${REF_LINE_FORMATS.join(', ')}` };
    }
    if (rest.length > 3) return { kind: 'error', text: formatUsage('Too many arguments.') };
    const options = { refLineFormat: head };
    if (rest.length === 3 && rest[1].toLowerCase() === 'chars') {
      const chars = Number(rest[2]);
      if (!Number.isInteger(chars) || chars < 0) return { kind: 'error', text: formatUsage(`chars "${rest[2]}" is not a non-negative integer.`) };
      options.thoughtChars = chars;
    } else if (rest.length === 2) {
      const chars = Number(rest[1]);
      if (!Number.isInteger(chars) || chars < 0) return { kind: 'error', text: formatUsage(`chars "${rest[1]}" is not a non-negative integer.`) };
      options.thoughtChars = chars;
    } else if (rest.length === 3) {
      return { kind: 'error', text: formatUsage('Use `<format> chars <n>` or `<format> <n>`.') };
    }
    return { kind: 'success', text: shapeSetText(engine.setShape(session, options)) };
  } catch (error) {
    return { kind: 'error', text: formatUsage(error instanceof Error ? error.message : String(error)) };
  }
}

/** Render the /fastcompact status report from what this engine recorded. */
export function statusText(status) {
  const { shape, last } = status;
  const lines = [
    `Engine: dsh-fast-compact (deterministic compiler — no model is asked to summarize).`,
    `Reference lines: ${describeShape(shape)}.`,
  ];
  // Live window accounting (row knob `debug` is NOT required for this: the command
  // always reports what the gate is and what the surface costs now, so "why did it
  // fire here" is answerable without waiting for the next compaction). Every figure
  // reads as a share of the WINDOW — the only two context knobs that matter are the
  // row's `thresholdRatio` (when to fire) and `contextMaxRatio` (what may survive).
  const window = status.window;
  if (window !== undefined && window !== null) {
    if (window.route === null || window.contextWindow === undefined) {
      lines.push(`Context window: capacity not known for this route; current messages ${groupInt(window.currentTokens)} tokens.`);
    } else {
      const gate = window.gateTokens;
      const clampPhrase = window.clampedToCeiling === true
        ? ` (the row wanted ${groupInt(window.requestedGateTokens)} tokens of that window; its messages top out at ${gate}, so pressure fires there)`
        : '';
      const borrowedPhrase = window.beyondBudget === true ? ' — a share past its message budget: pressure here runs on borrowed time' : '';
      lines.push(
        `Context window ${window.route}: ${groupInt(window.contextWindow)} tokens. `
        + `Pressure gate: row thresholdRatio ${window.thresholdRatio} of that window = ${groupInt(window.requestedGateTokens ?? gate)} tokens${usagePhrase(window.requestedGateTokens ?? gate, window)}${clampPhrase}${borrowedPhrase}; it is compared against the MESSAGES alone, so this route's tool schemas never count toward it. `
        + `Current messages: ${groupInt(window.currentTokens)} tokens${usagePhrase(window.currentTokens, window)}`
        + `${window.currentTokens >= gate ? ' — at or above the gate: the next request compacts.' : ' — below the gate: no compaction until it reaches ' + groupInt(gate) + ' tokens.'}`,
      );
    }
  }
  // The row's own knobs as they resolve for THIS session's route (engine.configStatus,
  // including any per-route modelPolicies override): when it fires, how much tail
  // survives verbatim, and the window share this plugin may keep in the compiled
  // checkpoint (its one knob that never reaches the base).
  const config = status.config;
  if (config !== undefined && config !== null) {
    const retain = typeof config.retainTokens === 'number' ? `retainTokens ${groupInt(config.retainTokens)}` : `retainRatio ${config.retainRatio ?? '—'}`;
    lines.push(`Config: thresholdRatio ${config.thresholdRatio ?? '—'}, ${retain}, contextMaxRatio ${config.contextMaxRatio ?? '—'}.`);
  }
  // The row knob `debug`: whether dumps are on, where they land (recomputed each
  // call — it follows the dsh process's CWD), and the file the last compaction of
  // this session wrote. Answers "why did /compact leave no dump file?" on the spot.
  const debug = status.debug;
  if (debug !== undefined && debug !== null) {
    lines.push(
      debug.enabled
        ? `Debug dumps: on → ${debug.dir}${debug.lastDump ? `; last compaction wrote ${debug.lastDump}` : ''}.`
        : 'Debug dumps: off.',
    );
  }
  if (last === undefined) {
    lines.push('No compaction by this engine in this session since dsh started.');
    return lines.join('\n');
  }
  const stats = last.stats;
  lines.push(
    `Last compaction (${last.at}): seq ${last.start}–${last.end} replaced by a checkpoint of ${formatKb(stats.bytes)} in ${stats.events} log events; `
    + `${stats.refs} reference lines${stats.refsDropped > 0 ? ` (${stats.refsDropped} older calls folded into one range line)` : ''}, `
    + `thought quoted from seq ${stats.thoughtSeq ?? '(none in span)'}, pinned seqs kept: ${stats.pinnedSeqs.length}.`,
  );
  if (stats.contextBlocks.length > 0) {
    lines.push(`Context blocks re-emitted: ${stats.contextBlocks.map((entry) => `${entry.kind} (seq ${entry.seq})`).join(', ')}.`);
  }
  const cs = stats.contextStats;
  if (cs !== undefined && cs !== null) {
    lines.push(
      `Window accounting: shadowed span ${groupInt(cs.shadowedTokens)} tokens${usagePhrase(cs.shadowedTokens, cs)} over seqs ${cs.rangeStart}–${cs.rangeEnd}; `
      + `checkpoint ${groupInt(cs.checkpointTokens)} tokens${usagePhrase(cs.checkpointTokens, cs)}. `
      + `Before ${groupInt(cs.beforeTokens)} tokens${usagePhrase(cs.beforeTokens, cs)} → after ~${groupInt(cs.afterTokens)} tokens${usagePhrase(cs.afterTokens, cs)}: `
      + `freed ${groupInt(cs.freedTokens)} tokens (${shareOf(cs.freedTokens, cs.beforeTokens)} of the surface).`,
    );
  }
  return lines.join('\n');
}

/**
 * Register `/recall` and `/fastcompact` on a commands-injected context.
 * @param ctx - context with `commands` and `compaction` (this engine).
 * @param {{ maxRecallChars: number }} budgets
 * @param {warn} [warn] - called with a message when a name is already taken.
 */
export function registerCommands(ctx, budgets, warn = () => {}) {
  const disposers = [];
  // A command name can already be taken (another preset mounting this plugin
  // into the same command layer, or another plugin). Commands are a
  // convenience: a failed registration is logged and skipped, and never
  // affects the engine or the tools.
  const register = (definition) => {
    try {
      disposers.push(ctx.commands.register(definition));
    } catch (error) {
      warn(`/${definition.name} not registered: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  register({
    name: 'recall',
    description: 'Show the original of an earlier conversation entry from the session log',
    input: { hint: '<seq> | <from>-<to> | result <seq>' },
    handler(invocation) {
      const request = parseRecallCommand(invocation.rawInput);
      if (request === null) return { kind: 'error', text: 'Usage: /recall <seq> | <from>-<to> | result <seq>' };
      try {
        const recalled = recall(invocation.agent.session, request, { maxChars: COMMAND_RECALL_CHARS });
        const more = recalled.nextOffset === null ? '' : '\n(Output truncated; ask the agent to recall the rest.)';
        return { kind: 'success', text: `${recalled.text.replace(/\n\n\[\d+ more characters; call again with offset \d+\]$/, '')}${more}` };
      } catch (error) {
        if (error instanceof RecallError) return { kind: 'error', text: error.message };
        throw error;
      }
    },
  });
  register({
    name: 'fastcompact',
    description: 'Show what the dsh-fast-compact compiler last wrote for this session; `/fastcompact format` changes the reference-line shape',
    input: { hint: '[format [<thought|none> [chars <n>] | chars <n> | reset]]' },
    handler(invocation) {
      const engine = ctx.compaction;
      if (typeof engine?.currentShape !== 'function') return { kind: 'error', text: 'dsh-fast-compact is not the compaction engine of this preset.' };
      const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter((token) => token !== '');
      if (tokens.length > 0 && tokens[0].toLowerCase() === 'format') return formatCommand(engine, invocation.agent.session, tokens.slice(1));
      if (tokens.length > 0) return { kind: 'error', text: `Unknown argument "${tokens[0]}". Usage: /fastcompact [format [<thought|none> [chars <n>] | chars <n> | reset]]` };
      const status = {
        shape: engine.currentShape(invocation.agent.session),
        last: engine.lastCompaction(invocation.agent.session),
        // Live gate + current surface when this engine can report them; an older
        // build without the method simply keeps the original two-field status.
        window: typeof engine.pressureReport === 'function' ? engine.pressureReport(invocation.agent.session) : null,
        // An older build without the method simply keeps the original status shape.
        debug: typeof engine.debugStatus === 'function' ? engine.debugStatus(invocation.agent.session) : null,
        config: typeof engine.configStatus === 'function' ? engine.configStatus(invocation.agent.session) : null,
      };
      return { kind: 'success', text: statusText(status) };
    },
  });
  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        /* already unregistered */
      }
    }
  };
}
