/**
 * Recall-aware retention.
 *
 * When the model recalls an entry, that content is evidently still needed.
 * The recall tools record the recalled seqs here, and the next compaction
 * marks matching checkpoint entries as pinned: kept at full length, excerpts
 * kept, never elided. Pins are cleared once a compaction has honored them
 * (the pinned lines then live on in the checkpoint, which is itself
 * protected when carried forward).
 *
 * Keyed by Session object in a WeakMap, so state is released with the session.
 *
 * The surface is one class: `Pins` owns the per-session pin sets as private
 * state and exposes them only through its static methods, so a caller cannot
 * reach the set itself — it asks to pin, reads a copy, or releases.
 *
 * @module dsh-fast-compact/pins
 */

const pinsBySession = new WeakMap();

/** Maximum pins kept per session; the oldest are dropped first. */
export const MAX_PINS = 200;

/** Recall-aware retention for sessions: pin, read, and release recalled seqs. */
export class Pins {
  /** Record recalled seqs for a session (the oldest beyond MAX_PINS drop out). */
  static pin(session, seqs) {
    if (session === undefined || session === null) return;
    let pins = pinsBySession.get(session);
    if (pins === undefined) {
      pins = new Set();
      pinsBySession.set(session, pins);
    }
    for (const seq of seqs) {
      if (!Number.isSafeInteger(seq)) continue;
      pins.delete(seq);
      pins.add(seq);
    }
    while (pins.size > MAX_PINS) pins.delete(pins.values().next().value);
  }

  /** Current pins for a session (a copy). */
  static pinsFor(session) {
    return new Set(pinsBySession.get(session) ?? []);
  }

  /** Drop pins that a compaction has now carried into its checkpoint. */
  static releasePins(session, seqs) {
    const pins = pinsBySession.get(session);
    if (pins === undefined) return;
    for (const seq of seqs) pins.delete(seq);
  }
}
