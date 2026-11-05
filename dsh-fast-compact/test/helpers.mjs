/**
 * Synthetic session fixtures for the suites in this package — a hand-built v3
 * log shape (turn/start, user/message, assistant/message with tool calls +
 * reasoning, tool/result), no private data.
 *
 * Two tool-result formats exist across dsh releases:
 *   - `v1` (dsh <0.1.7): a user-role message wrapping one `tool-result` block;
 *   - `v2` (dsh >=0.1.7): a tool-role message with top-level toolCallId/isError.
 */

/** Tool-result blocks of a message, in either dsh format. */
export function toolResultsOf(message) {
  if (message === null || typeof message !== 'object') return [];
  if (message.role === 'tool' && typeof message.toolCallId === 'string') {
    return [{ toolCallId: message.toolCallId, content: message.content, isError: message.isError === true }];
  }
  const out = [];
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (block?.type === 'tool-result' && typeof block.toolCallId === 'string') {
        out.push({ toolCallId: block.toolCallId, content: block.content, isError: block.isError === true });
      }
    }
  }
  return out;
}

/** Build one tool-result message in the requested format. */
export function toolResultMessage(id, content, { isError = false, format = 'v2', messageId = `r${id}` } = {}) {
  if (format === 'v2') return { role: 'tool', source: { kind: 'tool', callId: id }, toolCallId: id, isError, content, id: messageId };
  return { role: 'user', source: { kind: 'tool', callId: id }, content: [{ type: 'tool-result', toolCallId: id, content, isError }], id: messageId };
}

export function buildEvents({ turns = 6, callsPerTurn = 3, resultChars = 4000, argChars = 60, format = 'v2' } = {}) {
  const events = [];
  const push = (type, data, extra = {}) => {
    const event = { type, seq: events.length, time: 1_700_000_000_000 + events.length, data, ...extra };
    events.push(event);
    return event;
  };
  push('system/message', { turn: 1, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'You are a test agent.' }], source: format === 'v2' ? { kind: 'system-prompt' } : { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, id: 'sys' } }, { surfaceOp: 'append' });
  for (let turn = 1; turn <= turns; turn += 1) {
    push('turn/start', { turn });
    push('user/message', { role: 'user', content: [{ type: 'text', text: `Turn ${turn}: please work on task ${turn}.` }], source: { kind: 'user' }, id: `u${turn}` }, { surfaceOp: 'append' });
    for (let step = 1; step <= callsPerTurn; step += 1) {
      push('step/start', { turn, step });
      const id = `call_${turn}_${step}`;
      const args = JSON.stringify({ path: `src/file_${turn}_${step}.js`, content: 'x'.repeat(argChars) });
      push('assistant/message', {
        turn, step,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: `thinking deeply about turn ${turn} step ${step}` },
            { type: 'text', text: `Working on step ${step} of turn ${turn}.` },
            { type: 'tool-call', id, name: step % 2 ? 'write' : 'bash', arguments: args },
          ],
          source: { kind: 'model', provider: 'p', model: 'm' },
          id: `a${turn}_${step}`,
        },
        stream: [],
      }, { surfaceOp: 'append' });
      const assistantSeq = events.length - 1;
      push('tool/call', { turn, step, callId: id, name: step % 2 ? 'write' : 'bash', arguments: args });
      const content = [{ type: 'text', text: `RESULT-${turn}-${step} ` + 'r'.repeat(resultChars) + ` END-${turn}-${step}` }];
      push('tool/result', {
        turn, step,
        message: toolResultMessage(id, content, { format, messageId: `r${turn}_${step}` }),
      }, { surfaceOp: 'append', sourceEventSeqs: [assistantSeq + 1] });
      push('step/end', { turn, step });
    }
    push('assistant/message', {
      turn, step: callsPerTurn + 1,
      message: { role: 'assistant', content: [{ type: 'text', text: `Done with turn ${turn}.` }], source: { kind: 'model', provider: 'p', model: 'm' }, id: `af${turn}` },
      stream: [],
    }, { surfaceOp: 'append' });
    push('turn/end', { turn, reason: { kind: 'completed' } });
  }
  push('request/header', { header: { config: { provider: 'p', model: 'm' }, tools: [{ name: 'write', description: 'write a file', parameters: { type: 'object' } }] }, reason: 'initial' });
  return events;
}

/**
 * Map of call id -> { seqCall, seqResult, turn, name, keyArg, resultText }
 * for every tool call in an events array, for assertions against ref lines.
 */
export function expectedRefs(events) {
  const out = [];
  for (const event of events) {
    if (event.type !== 'assistant/message') continue;
    for (const block of event.data.message.content) {
      if (block?.type !== 'tool-call') continue;
      let keyArg;
      try {
        const args = JSON.parse(block.arguments);
        keyArg = typeof args.path === 'string' ? args.path : undefined;
      } catch { /* non-JSON args */ }
      out.push({
        id: block.id,
        seqCall: event.seq,
        turn: event.data.turn,
        name: block.name,
        keyArg,
        seqResult: undefined,
        resultText: undefined,
      });
    }
  }
  for (const event of events) {
    if (event.type !== 'tool/result') continue;
    const message = event.data.message;
    const results = toolResultsOf(message);
    for (const ref of out) {
      if (ref.id === results[0]?.toolCallId) {
        ref.seqResult = event.seq;
        ref.resultText = results[0].content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      }
    }
  }
  return out;
}
