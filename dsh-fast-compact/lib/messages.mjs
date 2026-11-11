/**
 * Message-shape adapter across dsh releases.
 *
 * dsh 0.1.5 stores a tool result as a user-role message whose single content
 * block is `{ type: 'tool-result', toolCallId, content, isError }`.
 * dsh 0.1.7 and later store it as a first-class tool-role message:
 * `{ role: 'tool', toolCallId, isError, content: [...blocks] }`.
 *
 * The same release moved the compaction checkpoint source from
 * `{ kind: 'plugin', plugin: 'compact' }` to `{ kind: 'compact-checkpoint' }`.
 *
 * Every module reads tool results and checkpoints through these helpers, so the
 * plugin works on both formats. Dependency-free.
 *
 * The surface is one class: `Messages` groups the shape readers as static
 * methods. They are pure adapters — no instance state — so call sites read
 * `Messages.toolResultsOf(...)` and the intent (this module's vocabulary) stays
 * visible at the point of use.
 *
 * @module dsh-fast-compact/messages
 */

export class Messages {
  /**
   * The tool results carried by one message, in either format.
   * @param {object | null | undefined} message - a derived message.
   * @returns {{ toolCallId: string, content: object[], isError: boolean }[]}
   */
  static toolResultsOf(message) {
    if (message === null || message === undefined) return [];
    if (message.role === 'tool') {
      return typeof message.toolCallId === 'string'
        ? [{ toolCallId: message.toolCallId, content: Array.isArray(message.content) ? message.content : [], isError: message.isError === true }]
        : [];
    }
    if (!Array.isArray(message.content)) return [];
    return message.content
      .filter((block) => block?.type === 'tool-result' && typeof block.toolCallId === 'string')
      .map((block) => ({ toolCallId: block.toolCallId, content: Array.isArray(block.content) ? block.content : [], isError: block.isError === true }));
  }

  /** The single tool result of a `tool/result` event's message, or undefined. */
  static toolResultOfEvent(event) {
    return Messages.toolResultsOf(event?.data?.message)[0];
  }

  /** Whether a message source marks a compaction checkpoint (any backend, any release). */
  static isCheckpointSource(source) {
    if (source === null || typeof source !== 'object') return false;
    return source.kind === 'compact-checkpoint' || (source.kind === 'plugin' && source.plugin === 'compact');
  }
}
