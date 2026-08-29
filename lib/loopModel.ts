/**
 * Pure model helpers for the envelope (bracket) selection workflow.
 * No React, no platform code — fully unit-testable.
 */

export interface BracketConfig {
  /** Full recording length in ms */
  duration: number;
  /** Locked master loop length in ms */
  masterDuration: number;
  /** Beats per master loop (locked with the tempo) */
  beatsPerLoop: number;
}

/** The default envelope position: the final loop-length of the take. */
export function defaultBracketMs(
  duration: number,
  masterDuration: number
): number {
  if (duration <= 0 || masterDuration <= 0) return 0;
  return Math.max(0, duration - masterDuration);
}

/**
 * Step the envelope by exactly one beat in the given direction.
 * Positions snap to the beat grid k·τ, clamped to [0, duration − masterDuration].
 */
export function nudgeBracket(
  currentMs: number,
  dir: -1 | 1,
  cfg: BracketConfig
): number {
  const { duration, masterDuration, beatsPerLoop } = cfg;
  if (duration <= 0 || masterDuration <= 0 || beatsPerLoop <= 0) return 0;
  const beat = masterDuration / beatsPerLoop;
  const max = Math.max(0, duration - masterDuration);
  const k = Math.round(currentMs / beat) + dir;
  const next = Math.max(0, Math.min(max, k * beat));
  return Number.isFinite(next) ? next : 0;
}

/** Human label for a recording's position relative to the master loop. */
export function loopPositionLabel(
  recordingMs: number,
  masterDuration: number,
  beatsPerLoop: number
): string {
  if (masterDuration <= 0 || beatsPerLoop <= 0) return "";
  const loops = Math.floor(recordingMs / masterDuration);
  const beatMs = masterDuration / beatsPerLoop;
  const beat = Math.floor((recordingMs % masterDuration) / beatMs);
  return `${loops} LOOP${loops === 1 ? "" : "S"} + ${beat} BEAT${beat === 1 ? "" : "S"}`;
}
