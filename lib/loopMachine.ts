/**
 * LoopLayer state machine — pure reducer + guard table.
 *
 * Replaces the scattered phase-field pattern with a single source of truth.
 * Every UI action becomes an intent; the reducer computes the next state.
 * Illegal intents return the current state + a `rejected` reason the UI
 * renders as a toast. This structurally eliminates silent dead taps,
 * orphaned armed state, double-commits, and phase/transport confusion.
 *
 * No React, no platform code — fully unit-testable.
 */

import type { Phase, PendingLoop, Loop } from "@/context/LoopContext";

// ── Transport (independent of phase) ─────────────────────────────────────

export type Transport = "running" | "paused";

// ── Intents ──────────────────────────────────────────────────────────────

export type LoopIntent =
  | { type: "ARM" }
  | { type: "DISARM" }
  | { type: "START_RECORDING" }
  | { type: "STOP_RECORDING"; durationMs: number }
  | { type: "RECORDING_COMPLETE"; uri: string; durationMs: number; rawUri?: string; rawDuration?: number; detectedBpm?: number | null; waveformData?: number[] }
  | { type: "CONFIRM_TRIM"; startTrim: number; endTrim: number }
  | { type: "CONFIRM_BRACKET"; bracketStartMs: number; volume?: number }
  | { type: "DISCARD_PENDING" }
  | { type: "EDIT_LOOP"; id: string }
  | { type: "CONFIRM_EDIT"; id: string; bracketStartMs: number }
  | { type: "CANCEL_EDIT" }
  | { type: "FINALIZE" }
  | { type: "UNFINALIZE" }
  | { type: "CLEAR_ALL" }
  | { type: "REMOVE_LOOP"; id: string }
  | { type: "TOGGLE_PLAYBACK" }
  | { type: "RECOVER" }
  | { type: "LOAD_SESSION" };

// ── Machine state ────────────────────────────────────────────────────────

export interface MachineState {
  phase: Phase;
  transport: Transport;
  loops: Loop[];
  pendingLoop: PendingLoop | null;
  masterDuration: number | null;
  editingLoop: Loop | null;
  recordingDuration: number;
}

// ── Reduction result ─────────────────────────────────────────────────────

export interface ReduceResult {
  state: MachineState;
  /** undefined = intent applied silently; string = rejected with reason */
  rejected?: string;
  /** Side-effects the caller must execute (never the reducer itself) */
  effects: MachineEffect[];
}

export type MachineEffect =
  | { type: "START_CLOCK"; fromPositionMs: number }
  | { type: "STOP_CLOCK" }
  | { type: "SAVE_LOOPS"; loops: Loop[] }
  | { type: "SAVE_MASTER"; duration: number }
  | { type: "CLEAR_MASTER" }
  | { type: "SYNC_LOOP"; loop: Loop; masterDuration: number; beatsPerLoop: number; detectedBpm?: number | null }
  | { type: "DELETE_SERVER_LOOP"; id: string }
  | { type: "REVOKE_BLOB"; uri: string }
  | { type: "SET_DISARM_TIMER"; ms: number }
  | { type: "CLEAR_DISARM_TIMER" }
  | { type: "HAPTIC_SUCCESS" }
  | { type: "HAPTIC_WARNING" }
  | { type: "SHOW_TOAST"; message: string };

// ── Constants ────────────────────────────────────────────────────────────

export const MAX_LOOPS = 5;
const DISARM_TIMEOUT_MS = 10_000;

// ── Guard predicates ─────────────────────────────────────────────────────

function canArm(s: MachineState): boolean {
  const currentCount = s.loops.length + (s.phase === "browsing" && s.pendingLoop ? 1 : 0);
  return (
    (s.phase === "idle" || s.phase === "playing" || s.phase === "browsing") &&
    s.masterDuration !== null &&
    s.masterDuration > 0 &&
    currentCount <= MAX_LOOPS
  );
}

function canStartRecording(s: MachineState): boolean {
  return s.phase === "armed" || (s.phase === "idle" && s.loops.length === 0);
}

function canStopRecording(s: MachineState): boolean {
  return s.phase === "recording";
}

function canConfirmTrim(s: MachineState): boolean {
  return s.phase === "trimming" && s.pendingLoop !== null;
}

function canConfirmBracket(s: MachineState): boolean {
  return s.phase === "browsing" && s.pendingLoop !== null && s.masterDuration !== null;
}

function canDiscardPending(s: MachineState): boolean {
  return s.phase === "trimming" || s.phase === "browsing";
}

function canEditLoop(s: MachineState): boolean {
  return s.phase === "playing" || s.phase === "finalized";
}

function canFinalize(s: MachineState): boolean {
  return (s.phase === "playing" || s.phase === "browsing") && (s.loops.length > 0 || s.pendingLoop !== null);
}

function canRemoveLoop(s: MachineState): boolean {
  return s.phase === "playing" || s.phase === "finalized";
}

function canRecover(s: MachineState): boolean {
  return s.phase === "recovering";
}

// ── The reducer ──────────────────────────────────────────────────────────

export function reduceLoopIntent(
  intent: LoopIntent,
  prev: MachineState,
  beatsPerLoop: number,
  clockRunning: boolean
): ReduceResult {
  const effects: MachineEffect[] = [];
  const s = { ...prev };

  switch (intent.type) {
    // ── ARM ──────────────────────────────────────────────────────────
    case "ARM": {
      if (!canArm(s)) {
        if (s.loops.length >= MAX_LOOPS) {
          return { state: prev, rejected: `Max ${MAX_LOOPS} layers reached`, effects: [] };
        }
        if (!s.masterDuration) {
          return { state: prev, rejected: "Record a loop first to set the tempo", effects: [] };
        }
        return { state: prev, rejected: "Can't arm right now", effects: [] };
      }

      // Provisional commit: if arming while browsing, commit the pending take
      if (s.phase === "browsing" && s.pendingLoop && s.masterDuration) {
        const md = s.masterDuration;
        const pending = s.pendingLoop;
        const start = Math.max(0, Math.min(pending.duration - md, pending.duration - md));
        const endTrim = Math.min(start + md, pending.duration);
        const newLoop: Loop = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
          videoUri: pending.uri,
          duration: pending.duration,
          startTrim: start,
          endTrim,
          waveformData: pending.waveformData,
          layerIndex: s.loops.length,
          volume: 1.0,
          muted: false,
          videoOpacity: 0.85,
          fullRecordingUri: pending.fullRecordingUri ?? pending.uri,
          fullRecordingDuration: pending.fullRecordingDuration ?? pending.duration,
          bracketStartMs: start,
        };
        s.loops = [...s.loops, newLoop];
        s.pendingLoop = null;
        effects.push({ type: "SAVE_LOOPS", loops: s.loops });
        effects.push({ type: "SYNC_LOOP", loop: newLoop, masterDuration: md, beatsPerLoop, detectedBpm: null });
      }

      s.phase = "armed";
      effects.push({ type: "SET_DISARM_TIMER", ms: DISARM_TIMEOUT_MS });
      if (!clockRunning) {
        effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
        s.transport = "running";
      }
      effects.push({ type: "HAPTIC_WARNING" });
      return { state: s, effects };
    }

    // ── DISARM ───────────────────────────────────────────────────────
    case "DISARM": {
      if (s.phase !== "armed") {
        return { state: prev, effects: [] };
      }
      s.phase = s.loops.length > 0 ? "playing" : "idle";
      effects.push({ type: "CLEAR_DISARM_TIMER" });
      return { state: s, effects };
    }

    // ── START_RECORDING ──────────────────────────────────────────────
    case "START_RECORDING": {
      if (!canStartRecording(s)) {
        return { state: prev, rejected: "Not armed", effects: [] };
      }
      s.phase = "recording";
      s.recordingDuration = 0;
      effects.push({ type: "CLEAR_DISARM_TIMER" });
      return { state: s, effects };
    }

    // ── STOP_RECORDING ───────────────────────────────────────────────
    case "STOP_RECORDING": {
      if (!canStopRecording(s)) {
        return { state: prev, effects: [] };
      }
      s.recordingDuration = intent.durationMs;
      // Phase stays "recording" until RECORDING_COMPLETE provides the URI.
      return { state: s, effects };
    }

    // ── RECORDING_COMPLETE ───────────────────────────────────────────
    case "RECORDING_COMPLETE": {
      if (s.phase !== "recording") {
        return { state: prev, effects: [] };
      }
      const waveformData = intent.waveformData ?? [];
      s.pendingLoop = {
        uri: intent.uri,
        duration: intent.durationMs,
        waveformData,
        fullRecordingUri: intent.rawUri ?? intent.uri,
        fullRecordingDuration: intent.rawDuration ?? intent.durationMs,
        detectedBpm: intent.detectedBpm ?? null,
      };
      s.phase = s.masterDuration === null ? "trimming" : "browsing";
      if (s.masterDuration !== null && !clockRunning) {
        effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
        s.transport = "running";
      }
      return { state: s, effects };
    }

    // ── CONFIRM_TRIM (first loop — sets master duration) ─────────────
    case "CONFIRM_TRIM": {
      if (!canConfirmTrim(s)) {
        return { state: prev, rejected: "No take to confirm", effects: [] };
      }
      const loopLen = intent.endTrim - intent.startTrim;
      if (!(loopLen > 0) || !Number.isFinite(loopLen)) {
        return { state: prev, rejected: "Invalid trim bounds", effects: [] };
      }
      if (s.masterDuration === null) {
        s.masterDuration = loopLen;
        effects.push({ type: "SAVE_MASTER", duration: loopLen });
      }
      const newLoop: Loop = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
        videoUri: s.pendingLoop!.uri,
        duration: s.pendingLoop!.duration,
        startTrim: intent.startTrim,
        endTrim: intent.endTrim,
        waveformData: s.pendingLoop!.waveformData,
        layerIndex: s.loops.length,
        volume: 1.0,
        muted: false,
        videoOpacity: 0.85,
        fullRecordingUri: s.pendingLoop!.fullRecordingUri ?? s.pendingLoop!.uri,
        fullRecordingDuration: s.pendingLoop!.fullRecordingDuration ?? s.pendingLoop!.duration,
        bracketStartMs: intent.startTrim,
      };
      s.loops = [...s.loops, newLoop];
      const detectedBpm = s.pendingLoop?.detectedBpm ?? null;
      s.pendingLoop = null;
      s.phase = "playing";
      s.transport = "running";
      effects.push({ type: "SAVE_LOOPS", loops: s.loops });
      effects.push({ type: "SYNC_LOOP", loop: newLoop, masterDuration: s.masterDuration!, beatsPerLoop, detectedBpm });
      effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
      return { state: s, effects };
    }

    // ── CONFIRM_BRACKET (subsequent loop) ────────────────────────────
    case "CONFIRM_BRACKET": {
      if (!canConfirmBracket(s)) {
        return { state: prev, rejected: "No take to confirm", effects: [] };
      }
      const md = s.masterDuration!;
      const start = Math.max(0, Math.min(intent.bracketStartMs, s.pendingLoop!.duration - md));
      const endTrim = Math.min(start + md, s.pendingLoop!.duration);
      if (endTrim <= start) {
        return { state: prev, rejected: "Invalid bracket — take too short", effects: [] };
      }
      const volume = Math.max(0, Math.min(1, intent.volume ?? 1));
      const newLoop: Loop = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
        videoUri: s.pendingLoop!.uri,
        duration: s.pendingLoop!.duration,
        startTrim: start,
        endTrim,
        waveformData: s.pendingLoop!.waveformData,
        layerIndex: s.loops.length,
        volume,
        muted: false,
        videoOpacity: 0.85,
        fullRecordingUri: s.pendingLoop!.fullRecordingUri ?? s.pendingLoop!.uri,
        fullRecordingDuration: s.pendingLoop!.fullRecordingDuration ?? s.pendingLoop!.duration,
        bracketStartMs: start,
      };
      s.loops = [...s.loops, newLoop];
      s.pendingLoop = null;
      s.phase = "playing";
      s.transport = "running";
      effects.push({ type: "SAVE_LOOPS", loops: s.loops });
      effects.push({ type: "SYNC_LOOP", loop: newLoop, masterDuration: md, beatsPerLoop, detectedBpm: null });
      effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
      return { state: s, effects };
    }

    // ── DISCARD_PENDING ──────────────────────────────────────────────
    case "DISCARD_PENDING": {
      if (!canDiscardPending(s)) {
        return { state: prev, effects: [] };
      }
      if (s.pendingLoop) {
        effects.push({ type: "REVOKE_BLOB", uri: s.pendingLoop.uri });
        if (s.pendingLoop.fullRecordingUri && s.pendingLoop.fullRecordingUri !== s.pendingLoop.uri) {
          effects.push({ type: "REVOKE_BLOB", uri: s.pendingLoop.fullRecordingUri });
        }
      }
      s.pendingLoop = null;
      s.phase = s.loops.length > 0 ? "playing" : "idle";
      return { state: s, effects };
    }

    // ── EDIT_LOOP ────────────────────────────────────────────────────
    case "EDIT_LOOP": {
      if (!canEditLoop(s)) {
        return { state: prev, effects: [] };
      }
      const loop = s.loops.find((l) => l.id === intent.id);
      if (!loop) {
        return { state: prev, rejected: "Layer not found", effects: [] };
      }
      s.editingLoop = loop;
      return { state: s, effects };
    }

    // ── CONFIRM_EDIT ─────────────────────────────────────────────────
    case "CONFIRM_EDIT": {
      if (!s.editingLoop || s.masterDuration === null) {
        return { state: prev, effects: [] };
      }
      const start = Math.max(0, Math.min(intent.bracketStartMs, s.editingLoop.duration - s.masterDuration));
      s.loops = s.loops.map((l) =>
        l.id === intent.id
          ? { ...l, startTrim: start, endTrim: Math.min(start + s.masterDuration!, l.duration), bracketStartMs: start }
          : l
      );
      s.editingLoop = null;
      effects.push({ type: "SAVE_LOOPS", loops: s.loops });
      return { state: s, effects };
    }

    // ── CANCEL_EDIT ──────────────────────────────────────────────────
    case "CANCEL_EDIT": {
      s.editingLoop = null;
      return { state: s, effects };
    }

    // ── FINALIZE ─────────────────────────────────────────────────────
    case "FINALIZE": {
      if (!canFinalize(s)) {
        if (s.loops.length === 0 && !s.pendingLoop) {
          return { state: prev, rejected: "Record at least one layer first", effects: [] };
        }
        return { state: prev, rejected: "Can't finalize right now", effects: [] };
      }

      // Provisional commit if finalizing while browsing
      if (s.phase === "browsing" && s.pendingLoop && s.masterDuration) {
        const md = s.masterDuration;
        const pending = s.pendingLoop;
        const start = Math.max(0, Math.min(pending.duration - md, pending.duration - md));
        const endTrim = Math.min(start + md, pending.duration);
        const newLoop: Loop = {
          id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
          videoUri: pending.uri,
          duration: pending.duration,
          startTrim: start,
          endTrim,
          waveformData: pending.waveformData,
          layerIndex: s.loops.length,
          volume: 1.0,
          muted: false,
          videoOpacity: 0.85,
          fullRecordingUri: pending.fullRecordingUri ?? pending.uri,
          fullRecordingDuration: pending.fullRecordingDuration ?? pending.duration,
          bracketStartMs: start,
        };
        s.loops = [...s.loops, newLoop];
        s.pendingLoop = null;
        effects.push({ type: "SYNC_LOOP", loop: newLoop, masterDuration: md, beatsPerLoop, detectedBpm: null });
      }

      s.phase = "finalized";
      s.editingLoop = null;
      effects.push({ type: "SAVE_LOOPS", loops: s.loops });
      effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
      s.transport = "running";
      return { state: s, effects };
    }

    // ── UNFINALIZE ───────────────────────────────────────────────────
    case "UNFINALIZE": {
      if (s.phase !== "finalized") {
        return { state: prev, effects: [] };
      }
      s.phase = "playing";
      return { state: s, effects };
    }

    // ── CLEAR_ALL ────────────────────────────────────────────────────
    case "CLEAR_ALL": {
      for (const l of s.loops) {
        effects.push({ type: "REVOKE_BLOB", uri: l.videoUri });
        effects.push({ type: "REVOKE_BLOB", uri: l.fullRecordingUri });
      }
      if (s.pendingLoop) {
        effects.push({ type: "REVOKE_BLOB", uri: s.pendingLoop.uri });
        if (s.pendingLoop.fullRecordingUri && s.pendingLoop.fullRecordingUri !== s.pendingLoop.uri) {
          effects.push({ type: "REVOKE_BLOB", uri: s.pendingLoop.fullRecordingUri });
        }
      }
      effects.push({ type: "STOP_CLOCK" });
      effects.push({ type: "CLEAR_DISARM_TIMER" });
      effects.push({ type: "SAVE_LOOPS", loops: [] });
      effects.push({ type: "CLEAR_MASTER" });
      return {
        state: {
          phase: "idle",
          transport: "paused",
          loops: [],
          pendingLoop: null,
          masterDuration: null,
          editingLoop: null,
          recordingDuration: 0,
        },
        effects,
      };
    }

    // ── REMOVE_LOOP ──────────────────────────────────────────────────
    case "REMOVE_LOOP": {
      if (!canRemoveLoop(s)) {
        return { state: prev, effects: [] };
      }
      const toRemove = s.loops.find((l) => l.id === intent.id);
      if (!toRemove) {
        return { state: prev, rejected: "Layer not found", effects: [] };
      }
      effects.push({ type: "REVOKE_BLOB", uri: toRemove.videoUri });
      effects.push({ type: "REVOKE_BLOB", uri: toRemove.fullRecordingUri });
      effects.push({ type: "DELETE_SERVER_LOOP", id: intent.id });
      const updated = s.loops
        .filter((l) => l.id !== intent.id)
        .map((l, i) => ({ ...l, layerIndex: i }));
      s.loops = updated;
      if (s.editingLoop?.id === intent.id) s.editingLoop = null;
      if (updated.length === 0) {
        s.phase = "idle";
        s.masterDuration = null;
        s.transport = "paused";
        effects.push({ type: "STOP_CLOCK" });
        effects.push({ type: "CLEAR_MASTER" });
      } else if (toRemove.layerIndex === 0) {
        // Tempo-defining layer removed — re-anchor master.
        const nextMaster = updated[0].endTrim - updated[0].startTrim;
        if (nextMaster > 0) {
          s.masterDuration = nextMaster;
          effects.push({ type: "SAVE_MASTER", duration: nextMaster });
          effects.push({ type: "SHOW_TOAST", message: "Tempo re-anchored — BPM may have changed" });
        }
      }
      effects.push({ type: "SAVE_LOOPS", loops: s.loops });
      return { state: s, effects };
    }

    // ── TOGGLE_PLAYBACK ──────────────────────────────────────────────
    case "TOGGLE_PLAYBACK": {
      if (s.transport === "running") {
        s.transport = "paused";
        effects.push({ type: "STOP_CLOCK" });
      } else {
        s.transport = "running";
        effects.push({ type: "START_CLOCK", fromPositionMs: 0 });
      }
      return { state: s, effects };
    }

    // ── RECOVER ──────────────────────────────────────────────────────
    case "RECOVER": {
      if (!canRecover(s)) {
        return { state: prev, effects: [] };
      }
      // Enter trimming with the first loop's recording as the pending take.
      const first = s.loops[0];
      if (!first) {
        return { state: prev, rejected: "No layers to recover from", effects: [] };
      }
      s.pendingLoop = {
        uri: first.videoUri,
        duration: first.fullRecordingDuration || first.duration,
        waveformData: first.waveformData,
        fullRecordingUri: first.fullRecordingUri,
        fullRecordingDuration: first.fullRecordingDuration,
        detectedBpm: null,
      };
      s.phase = "trimming";
      return { state: s, effects };
    }

    // ── LOAD_SESSION ─────────────────────────────────────────────────
    case "LOAD_SESSION": {
      // The actual session loading is handled by the caller (LoopContext).
      // This intent just validates the transition is legal.
      return { state: s, effects };
    }
  }
}

// ── Event log (ring buffer for observability) ────────────────────────────

export interface MachineEvent {
  intent: string;
  from: Phase;
  to: Phase;
  rejected?: string;
  ts: number;
}

const EVENT_RING_SIZE = 64;
const eventRing: MachineEvent[] = [];

export function logMachineEvent(
  intent: string,
  from: Phase,
  to: Phase,
  rejected?: string
): void {
  eventRing.push({ intent, from, to, rejected, ts: Date.now() });
  if (eventRing.length > EVENT_RING_SIZE) {
    eventRing.shift();
  }
}

export function getMachineEvents(): readonly MachineEvent[] {
  return eventRing;
}
