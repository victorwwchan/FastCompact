/**
 * dsh-fast-compact — text sizing and clipping.
 *
 * Everything this plugin emits is measured in UTF-8 bytes (the request body is
 * bytes, not characters), and every clipped piece names where the whole text can
 * be read back through the session log, so a shortened quote is never a dead end.
 *
 * @module dsh-fast-compact/lib/measure
 */

const encoder = new TextEncoder();

/** UTF-8 byte length of a string. */
export function utf8Bytes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let ascii = true;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      ascii = false;
      break;
    }
  }
  if (ascii) return text.length;
  return encoder.encode(text).length;
}

/** Kilobytes, one decimal, for the human-readable size fields. */
export function formatKb(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0.0 KB';
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/** One line, control characters folded away. */
export function oneLine(text) {
  return String(text).replace(/\s+/g, ' ').trim();
}

/**
 * Clip text to `maxChars` code points, keeping both ends and naming where the
 * whole text can be fetched back. The head carries most of the budget because
 * the first words of a thought already say what the agent was going to do; the
 * tail is kept so a model cut mid-sentence resumes where it stopped.
 * @param {number} maxChars - code-point budget (0 = return the text as-is).
 * @param {string} pointer - restored-content hint appended inside the gap.
 * @param {number} tailFraction - share of the budget spent on the tail.
 */
export function clipText(text, maxChars, pointer = '', tailFraction = 0.25) {
  const single = String(text).replace(/\r\n/g, '\n').trim();
  if (maxChars <= 0) return single;
  const units = [...single];
  if (units.length <= maxChars) return single;
  const gap = pointer === '' ? '[…]' : `[…] ${pointer} […]`;
  const gapUnits = [...gap].length;
  // The newlines joining the pieces are part of the budget too, so a clipped text
  // never runs past `maxChars` — unless the budget is smaller than the gap marker
  // itself, where keeping the pointer costs a bounded overshoot.
  if (tailFraction <= 0) {
    const headChars = Math.max(1, maxChars - gapUnits - 1);
    return [units.slice(0, headChars).join(''), gap].join('\n');
  }
  const room = Math.max(1, maxChars - gapUnits - 2);
  const tailChars = Math.min(room - 1, Math.max(0, Math.floor(room * tailFraction)));
  const headChars = room - tailChars;
  if (tailChars <= 0) return [units.slice(0, headChars).join(''), gap].join('\n');
  return [
    units.slice(0, headChars).join(''),
    gap,
    units.slice(units.length - tailChars).join(''),
  ].join('\n');
}

/** Quote one line for a config-ish list entry, folding it to a single line. */
export function quoted(text) {
  return JSON.stringify(oneLine(text));
}
