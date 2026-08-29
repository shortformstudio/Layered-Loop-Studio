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

// ── Bracket clamp guards (G27, G18) ────────────────────────────────────────
// Every numeric commit routes through these. Negative-length loops and
// NaN/zero-duration crashes become structurally impossible.

const MIN_LOOP_MS = 50;

/**
 * Clamp a bracket start so the resulting loop is valid.
 * Returns a safe startMs; the caller computes endTrim = startMs + masterDuration.
 */
export function clampBracketStart(
  duration: number,
  masterDuration: number,
  requestedStart: number
): number {
  if (!Number.isFinite(requestedStart) || requestedStart < 0) return 0;
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (!Number.isFinite(masterDuration) || masterDuration <= 0) return 0;
  const max = Math.max(0, duration - masterDuration);
  return Math.max(0, Math.min(max, requestedStart));
}

/**
 * Clamp trim bounds for the first loop (TrimEditor).
 * Returns { start, end } guaranteed: start >= 0, end > start, end <= duration,
 * and end - start >= MIN_LOOP_MS.
 */
export function clampTrimBounds(
  duration: number,
  start: number,
  end: number
): { start: number; end: number } {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { start: 0, end: 0 };
  }
  const safeDur = Math.max(MIN_LOOP_MS, duration);
  const clampedStart = Math.max(0, Math.min(start, safeDur - MIN_LOOP_MS));
  const clampedEnd = Math.max(clampedStart + MIN_LOOP_MS, Math.min(end, safeDur));
  return { start: clampedStart, end: clampedEnd };
}

/**
 * Safe duration for display — prevents NaN/Infinity from propagating
 * into layout calculations. (G18)
 */
export function safeDuration(value: number, fallback = 1000): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
