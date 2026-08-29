import AsyncStorage from "@react-native-async-storage/async-storage";
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { Platform } from "react-native";
import { File } from "expo-file-system";
import { syntheticWaveform, type AudioAnalysis } from "@/utils/audio-analysis";
import { defaultBracketMs, nudgeBracket } from "@/lib/loopModel";
import { syncLoopToServer, deleteLoopFromServer } from "@/lib/loopSync";

export interface Loop {
  id: string;
  videoUri: string;
  duration: number;
  startTrim: number;
  endTrim: number;
  waveformData: number[];
  layerIndex: number;
  volume: number;
  muted: boolean;
  videoOpacity: number;
  /** URI of the full raw recording this loop was cut from */
  fullRecordingUri: string;
  /** Duration of the full raw recording */
  fullRecordingDuration: number;
  /** The movable timeframe bracket start position (ms into full recording) */
  bracketStartMs: number;
}

export type Phase =
  | "idle"
  | "armed"       // armed — yellow light, waiting for next loop boundary
  | "recording"   // actively recording
  | "trimming"    // first loop — choose trim bounds
  | "browsing"    // subsequent loop — choose bracket within recording
  | "playing"
  | "finalized";

export interface PendingLoop {
  uri: string;
  duration: number;
  waveformData: number[];
  fullRecordingUri?: string;
  fullRecordingDuration?: number;
  /** Tempo detected from the recording (web); null when unknown */
  detectedBpm?: number | null;
}

interface TrackPatch {
  volume?: number;
  muted?: boolean;
  videoOpacity?: number;
}

interface LoopContextType {
  loops: Loop[];
  phase: Phase;
  pendingLoop: PendingLoop | null;
  recordingDuration: number;
  isGlobalPlaying: boolean;
  masterDuration: number | null;
  editingLoop: Loop | null;
  soloedId: string | null;
  /** Whether monitor output routing is active */
  monitorOn: boolean;
  setMonitorOn: (v: boolean) => void;
  maxLoops: number;
  /** Beats per master loop — locked at first-loop trim; drives BPM, count-in, snapping. */
  beatsPerLoop: number;
  /** Lock the beat grid. Only effective while the master tempo is unset — afterwards it is a no-op (set in stone). */
  lockBeatsPerLoop: (b: number) => void;
  /** Arm recording — yellow light, auto-triggers at next loop boundary. Returns false when arming is not possible. */
  armRecording: () => boolean;
  disarmRecording: () => void;
  startRecording: () => void;
  stopAndMeasure: () => number;
  onRecordingComplete: (uri: string, durationMs: number, analysis?: Partial<AudioAnalysis>) => void;
  onRecordingCompleteWithRaw: (
    uri: string,
    durationMs: number,
    rawUri: string,
    rawDuration: number,
    analysis?: Partial<AudioAnalysis>
  ) => void;
  confirmLoop: (startTrim: number, endTrim: number) => void;
  confirmBracket: (bracketStartMs?: number, volume?: number) => void;
  discardPending: () => void;
  /** Envelope position (ms into the pending take) — defaults to the tail. */
  pendingBracketMs: number;
  /** Step the envelope ±1 beat while browsing. */
  nudgePendingBracket: (dir: -1 | 1) => void;
  /** Set the envelope to an explicit clamped position (drag / scrub). */
  setPendingBracket: (ms: number) => void;
  removeLoop: (id: string) => void;
  toggleGlobalPlayback: () => void;
  clearAll: () => void;
  startEditLoop: (id: string) => void;
  confirmEditBracket: (id: string, bracketStartMs: number) => void;
  cancelEditLoop: () => void;
  finalizeProject: () => void;
  updateLoopTrack: (id: string, patch: TrackPatch) => void;
  setSoloedId: (id: string | null) => void;
  /** Get the next loop boundary time based on current playback position */
  getNextLoopBoundary: () => number | null;
  /** Current playback position in ms within the master loop, or null when idle */
  getPlaybackPosition: () => number | null;
  /** Subscribe to playback position updates while playing. Returns unsubscribe. */
  subscribePlayback: (cb: (positionMs: number) => void) => () => void;
  /** Saved session snapshots — shown on the entrance under "saved sessions". */
  savedSessions: SavedSession[];
  /** Stash the current project into the saved-sessions list. No-op when empty. */
  saveCurrentToSessions: () => void;
  /** Load a saved session into the active project. Returns false when its files are gone. */
  loadSession: (session: SavedSession) => boolean;
}

const LoopContext = createContext<LoopContextType | null>(null);

const MAX_LOOPS = 5;
const STORAGE_KEY = "looplayer_loops_v3";
const STORAGE_KEY_MASTER = "looplayer_master_duration";
const STORAGE_KEY_MONITOR = "looplayer_monitor_on";
const STORAGE_KEY_BEATS = "looplayer_beats_per_loop";
const STORAGE_KEY_SESSIONS = "looplayer_saved_sessions";
const STORAGE_KEY_SESSION_ID = "looplayer_session_id";

/** A saved project snapshot — listed on the entrance under "saved sessions". */
export interface SavedSession {
  id: string;
  savedAt: number;
  layerCount: number;
  masterDuration: number;
  loops: Loop[];
  beatsPerLoop: number;
}

/** Supported beat grids — locked with the master tempo. */
const VALID_BEATS = [2, 4, 8, 16];
const BEATS_DEFAULT = 4;

function revokeBlobURI(uri: string | undefined): void {
  if (!uri || !uri.startsWith("blob:")) return;
  try { URL.revokeObjectURL(uri); } catch { /* ignore revoke errors */ }
}

function hydrateLoop(raw: Partial<Loop>, index: number): Loop {
  return {
    volume: 1.0,
    muted: false,
    videoOpacity: 0.85,
    duration: 0,
    startTrim: 0,
    endTrim: 0,
    waveformData: [],
    fullRecordingUri: "",
    fullRecordingDuration: 0,
    bracketStartMs: 0,
    ...raw,
    layerIndex: index,
    // isHydratableLoop() guards these before hydrateLoop() is ever called
    id: raw.id!,
    videoUri: raw.videoUri!,
  };
}

function isHydratableLoop(raw: Partial<Loop>): boolean {
  return typeof raw.id === "string" && typeof raw.videoUri === "string" && raw.videoUri.length > 0;
}

/** Drop loops whose media file no longer exists (native) or whose URI died (web blob). */
function filterLiveLoops(loops: Loop[]): Loop[] {
  if (Platform.OS === "web") {
    return loops.filter((l) => !l.videoUri.startsWith("blob:"));
  }
  return loops.filter((l) => {
    try {
      return new File(l.videoUri).exists;
    } catch {
      return false;
    }
  });
}

export function LoopProvider({ children }: { children: React.ReactNode }) {
  const [loops, setLoops] = useState<Loop[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [pendingLoop, setPendingLoop] = useState<PendingLoop | null>(null);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const [isGlobalPlaying, setIsGlobalPlaying] = useState(true);
  const [masterDuration, setMasterDuration] = useState<number | null>(null);
  const [editingLoop, setEditingLoop] = useState<Loop | null>(null);
  const [soloedId, setSoloedId] = useState<string | null>(null);
  const [monitorOn, setMonitorOnState] = useState(false);
  const [beatsPerLoop, setBeatsPerLoopState] = useState<number>(BEATS_DEFAULT);
  const [pendingBracketMs, setPendingBracketMs] = useState(0);
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);

  // Refs mirroring state for callbacks that must stay dependency-light.
  const loopsRef = useRef<Loop[]>([]);
  loopsRef.current = loops;
  const pendingLoopRef = useRef<PendingLoop | null>(null);
  pendingLoopRef.current = pendingLoop;
  const beatsRef = useRef(beatsPerLoop);
  beatsRef.current = beatsPerLoop;
  const sessionIdRef = useRef<string | null>(null);

  const lockBeatsPerLoop = useCallback((b: number) => {
    // Locked once the master tempo exists — the beat grid is set in stone.
    if (masterDurationRef.current !== null) return;
    if (!VALID_BEATS.includes(b)) return;
    setBeatsPerLoopState(b);
    AsyncStorage.setItem(STORAGE_KEY_BEATS, String(b)).catch(() => {});
  }, []);

  const recordingStartTime = useRef<number>(0);
  const recordingTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const masterDurationRef = useRef<number | null>(null);
  const disarmTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmBracketRef = useRef<(bracketStartMs?: number, volume?: number) => void>(
    () => {}
  );

  // ── Shared playback clock ──────────────────────────────────────────────
  // One epoch anchors every layer. Position = (now − epoch) % masterDuration.
  // On pause the residual offset is preserved so play resumes mid-phrase
  // without any timeline adjustment.
  const clockEpoch = useRef<number>(0);
  const clockPausedOffset = useRef<number>(0);
  const clockTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockSubscribers = useRef<Set<(positionMs: number) => void>>(new Set());

  const startClock = useCallback(() => {
    if (clockTickTimer.current) clearInterval(clockTickTimer.current);
    clockTickTimer.current = setInterval(() => {
      const md = masterDurationRef.current;
      if (!md || md <= 0) return;
      const position = ((Date.now() - clockEpoch.current) % md + md) % md;
      clockSubscribers.current.forEach((cb) => cb(position));
    }, 100);
  }, []);

  const stopClock = useCallback(() => {
    if (clockTickTimer.current) {
      clearInterval(clockTickTimer.current);
      clockTickTimer.current = null;
    }
  }, []);

  const getPlaybackPosition = useCallback((): number | null => {
    const md = masterDurationRef.current;
    if (!md || md <= 0) return null;
    return ((Date.now() - clockEpoch.current) % md + md) % md;
  }, []);

  const subscribePlayback = useCallback((cb: (positionMs: number) => void) => {
    clockSubscribers.current.add(cb);
    return () => {
      clockSubscribers.current.delete(cb);
    };
  }, []);

  const startPlayback = useCallback((fromPositionMs = 0) => {
    const md = masterDurationRef.current;
    if (!md || md <= 0) return;
    clockEpoch.current = Date.now() - fromPositionMs;
    clockPausedOffset.current = 0;
    startClock();
    setIsGlobalPlaying(true);
  }, [startClock]);

  const stopPlayback = useCallback(() => {
    clockPausedOffset.current = getPlaybackPosition() ?? 0;
    stopClock();
    setIsGlobalPlaying(false);
  }, [getPlaybackPosition, stopClock]);

  const toggleGlobalPlayback = useCallback(() => {
    // Provisional commit: any transport intent keeps the pending take first.
    if (pendingLoopRef.current) {
      confirmBracketRef.current();
    }
    if (clockTickTimer.current) {
      stopPlayback();
    } else {
      startPlayback(clockPausedOffset.current);
    }
  }, [startPlayback, stopPlayback]);

  const setMonitorOn = useCallback((v: boolean) => {
    setMonitorOnState(v);
    AsyncStorage.setItem(STORAGE_KEY_MONITOR, String(v)).catch(() => {});
  }, []);

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(STORAGE_KEY_MASTER),
      AsyncStorage.getItem(STORAGE_KEY_MONITOR),
      AsyncStorage.getItem(STORAGE_KEY_BEATS),
      AsyncStorage.getItem(STORAGE_KEY_SESSIONS),
      AsyncStorage.getItem(STORAGE_KEY_SESSION_ID),
    ])
      .then(([rawLoops, rawMaster, rawMonitor, rawBeats, rawSessions, rawSessionId]) => {
        let hydratedLoops = false;
        let droppedAllLoops = false;
        if (rawLoops) {
          let saved: Loop[] = [];
          try {
            let candidates = (JSON.parse(rawLoops) as Partial<Loop>[])
              .filter(isHydratableLoop)
              // blob: URIs are per-session on web and die on reload — drop them
              .filter((l) => !l.videoUri?.startsWith("blob:"));
            // Dead-file guard: a loop whose video file no longer exists
            // (cleared cache, reinstalled Expo Go) would hand AVPlayer a
            // missing file:// — a native crash on iOS. Drop it up front.
            if (Platform.OS !== "web") {
              const kept: Partial<Loop>[] = [];
              for (const l of candidates) {
                let exists = false;
                try {
                  exists = new File(l.videoUri!).exists;
                } catch {
                  exists = false;
                }
                if (exists) kept.push(l);
                else console.log("[context] dropping loop with missing file:", l.videoUri);
              }
              candidates = kept;
            }
            saved = candidates.map((l, i) => hydrateLoop(l, i));
          } catch {
            saved = [];
          }
          setLoops(saved);
          if (saved.length > 0) {
            hydratedLoops = true;
            setPhase("playing");
          } else {
            droppedAllLoops = true;
          }
        }
        if (rawMaster && !droppedAllLoops) {
          const master = parseFloat(rawMaster);
          if (Number.isFinite(master) && master > 0) {
            setMasterDuration(master);
            masterDurationRef.current = master;
          }
        }
        if (droppedAllLoops) {
          AsyncStorage.removeItem(STORAGE_KEY_MASTER).catch(() => {});
          AsyncStorage.removeItem(STORAGE_KEY_BEATS).catch(() => {});
        }
        if (rawMonitor) {
          setMonitorOnState(rawMonitor === "true");
        }
        if (rawBeats) {
          const beats = parseInt(rawBeats, 10);
          if (VALID_BEATS.includes(beats)) {
            setBeatsPerLoopState(beats);
          }
        }
        if (rawSessions) {
          try {
            const parsed = JSON.parse(rawSessions);
            if (Array.isArray(parsed)) {
              setSavedSessions(parsed as SavedSession[]);
            }
          } catch {
            /* corrupt sessions list — start empty */
          }
        }
        if (rawSessionId) {
          sessionIdRef.current = rawSessionId;
        }
        if (hydratedLoops && masterDurationRef.current) {
          startPlayback(0);
        }
      })
      .catch(() => {});

    return () => {
      if (recordingTimer.current) {
        clearInterval(recordingTimer.current);
        recordingTimer.current = null;
      }
      if (disarmTimeoutRef.current) {
        clearTimeout(disarmTimeoutRef.current);
        disarmTimeoutRef.current = null;
      }
    };
  }, []);

  const saveLoops = useCallback((updated: Loop[]) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
  }, []);

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistLoops = useCallback(
    (updated: Loop[]) => {
      if (persistTimer.current) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        saveLoops(updated);
      }, 180);
    },
    [saveLoops]
  );

  const flushPersist = useCallback(() => {
    if (persistTimer.current) {
      clearTimeout(persistTimer.current);
      persistTimer.current = null;
      // Crash safety: never drop the debounced write — commit the latest
      // snapshot immediately instead of losing it at teardown.
      saveLoops(loopsRef.current);
    }
  }, [saveLoops]);

  const saveMasterDuration = useCallback((dur: number) => {
    AsyncStorage.setItem(STORAGE_KEY_MASTER, String(dur)).catch(() => {});
  }, []);

  // ── Saved sessions ──────────────────────────────────────────────────────
  // The active project persists on every change (crash-safe). Stashing
  // snapshots it into the "saved sessions" list whenever the user moves to
  // a fresh loop or switches sessions — so nothing is ever overwritten.

  const saveCurrentToSessions = useCallback(() => {
    const cur = loopsRef.current;
    if (cur.length === 0) return;
    let sid = sessionIdRef.current;
    if (!sid) {
      sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      sessionIdRef.current = sid;
      AsyncStorage.setItem(STORAGE_KEY_SESSION_ID, sid).catch(() => {});
    }
    const entry: SavedSession = {
      id: sid,
      savedAt: Date.now(),
      layerCount: cur.length,
      masterDuration: masterDurationRef.current ?? 0,
      loops: cur,
      beatsPerLoop: beatsRef.current,
    };
    setSavedSessions((prev) => {
      const next = [entry, ...prev.filter((s) => s.id !== sid)];
      AsyncStorage.setItem(STORAGE_KEY_SESSIONS, JSON.stringify(next)).catch(() => {});
      return next;
    });
  }, []);

  const loadSession = useCallback(
    (session: SavedSession): boolean => {
      // Never lose the current project — stash it before switching away.
      if (loopsRef.current.length > 0) {
        saveCurrentToSessions();
      }
      const live = filterLiveLoops(session.loops);
      if (live.length === 0) return false;
      const normalized = live.map((l, i) => ({ ...l, layerIndex: i }));
      loopsRef.current = normalized;
      setLoops(normalized);
      const md = session.masterDuration > 0 ? session.masterDuration : null;
      masterDurationRef.current = md;
      setMasterDuration(md);
      const beats = VALID_BEATS.includes(session.beatsPerLoop)
        ? session.beatsPerLoop
        : BEATS_DEFAULT;
      setBeatsPerLoopState(beats);
      setPendingLoop(null);
      setPendingBracketMs(0);
      setEditingLoop(null);
      setSoloedId(null);
      setPhase("playing");
      sessionIdRef.current = session.id;
      AsyncStorage.setItem(STORAGE_KEY_SESSION_ID, session.id).catch(() => {});
      AsyncStorage.setItem(STORAGE_KEY_BEATS, String(beats)).catch(() => {});
      // The loaded session becomes the active project — persisted so a crash
      // mid-session restores it on the next boot.
      saveLoops(normalized);
      if (md) {
        saveMasterDuration(md);
        startPlayback(0);
      } else {
        stopPlayback();
      }
      return true;
    },
    [saveCurrentToSessions, saveLoops, saveMasterDuration, startPlayback, stopPlayback]
  );

  const getNextLoopBoundary = useCallback((): number | null => {
    if (!masterDurationRef.current) return null;
    const now = Date.now();
    const elapsed = now - clockEpoch.current;
    const loopLen = masterDurationRef.current;
    const currentCycle = Math.floor(elapsed / loopLen);
    const nextBoundary = (currentCycle + 1) * loopLen;
    return nextBoundary - elapsed;
  }, []);

  const armRecording = useCallback((): boolean => {
    if (!masterDurationRef.current) return false;
    // Provisional commit: an unconfirmed take is kept at its current
    // envelope before arming the next one — one tap, zero decisions.
    if (pendingLoopRef.current) {
      confirmBracketRef.current();
    }
    if (loopsRef.current.length >= MAX_LOOPS) return false;
    // Quantization needs a live clock — resume playback if paused so the
    // armed take always starts on the next beat of a running loop.
    if (!clockTickTimer.current) {
      startPlayback(clockPausedOffset.current);
    }
    setPhase("armed");
    if (disarmTimeoutRef.current) clearTimeout(disarmTimeoutRef.current);
    return true;
  }, [startPlayback]);

  const disarmRecording = useCallback(() => {
    if (disarmTimeoutRef.current) {
      clearTimeout(disarmTimeoutRef.current);
      disarmTimeoutRef.current = null;
    }
    setPhase(loops.length > 0 ? "playing" : "idle");
  }, [loops.length]);

  const startRecording = useCallback(() => {
    if (loops.length >= MAX_LOOPS) return;
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    recordingStartTime.current = Date.now();
    setPhase("recording");
    setRecordingDuration(0);
    recordingTimer.current = setInterval(() => {
      setRecordingDuration(Date.now() - recordingStartTime.current);
    }, 500);
  }, [loops.length]);

  const stopAndMeasure = useCallback((): number => {
    if (recordingStartTime.current === 0) return 0;
    const elapsed = Date.now() - recordingStartTime.current;
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    return elapsed;
  }, []);

  const onRecordingComplete = useCallback((uri: string, durationMs: number, analysis?: Partial<AudioAnalysis>) => {
    const waveformData = analysis?.waveformData ?? syntheticWaveform(uri + durationMs);
    setPendingLoop({
      uri,
      duration: durationMs,
      waveformData,
      detectedBpm: analysis?.bpm ?? null,
    });
    // Envelope defaults to the tail of the take — provisional commit.
    setPendingBracketMs(defaultBracketMs(durationMs, masterDurationRef.current ?? 0));
    setPhase(masterDurationRef.current === null ? "trimming" : "browsing");
    // Keep the master clock running while the bracket is chosen — all layers
    // play on loop through the whole selection phase.
    if (masterDurationRef.current !== null && !clockTickTimer.current) {
      startPlayback(clockPausedOffset.current);
    }
  }, [startPlayback]);

  const onRecordingCompleteWithRaw = useCallback(
    (uri: string, durationMs: number, rawUri: string, rawDuration: number, analysis?: Partial<AudioAnalysis>) => {
      const waveformData = analysis?.waveformData ?? syntheticWaveform(uri + durationMs);
      setPendingLoop({
        uri,
        duration: durationMs,
        waveformData,
        fullRecordingUri: rawUri,
        fullRecordingDuration: rawDuration,
        detectedBpm: analysis?.bpm ?? null,
      });
      setPendingBracketMs(defaultBracketMs(durationMs, masterDurationRef.current ?? 0));
      setPhase(masterDurationRef.current === null ? "trimming" : "browsing");
      if (masterDurationRef.current !== null && !clockTickTimer.current) {
        startPlayback(clockPausedOffset.current);
      }
    },
    [startPlayback]
  );

  const confirmLoop = useCallback(
    (startTrim: number, endTrim: number) => {
      if (!pendingLoop) return;
      const loopLen = endTrim - startTrim;
      if (!(loopLen > 0) || !Number.isFinite(loopLen)) return;
      if (masterDurationRef.current === null) {
        masterDurationRef.current = loopLen;
        setMasterDuration(loopLen);
        saveMasterDuration(loopLen);
      }
      const newLoop: Loop = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
        videoUri: pendingLoop.uri,
        duration: pendingLoop.duration,
        startTrim,
        endTrim,
        waveformData: pendingLoop.waveformData,
        layerIndex: loops.length,
        volume: 1.0,
        muted: false,
        videoOpacity: 0.85,
        fullRecordingUri: pendingLoop.fullRecordingUri ?? pendingLoop.uri,
        fullRecordingDuration: pendingLoop.fullRecordingDuration ?? pendingLoop.duration,
        bracketStartMs: startTrim,
      };
      const updated = [...loops, newLoop];
      loopsRef.current = updated;
      setLoops(updated);
      saveLoops(updated);
      void syncLoopToServer(
        newLoop,
        masterDurationRef.current ?? 0,
        beatsRef.current,
        pendingLoop.detectedBpm ?? null
      );
      setPendingLoop(null);
      setPhase("playing");
      startPlayback(0);
    },
    [pendingLoop, loops, saveLoops, saveMasterDuration, startPlayback]
  );

  const confirmBracket = useCallback(
    (bracketStartMs?: number, layerVolume = 1) => {
      if (!pendingLoop || masterDurationRef.current === null) return;
      // Defaults to the current envelope position — provisional commit keeps
      // whatever the user nudged with the arrows before the next intent.
      const start = bracketStartMs ?? pendingBracketMs;
      if (!Number.isFinite(start) || start < 0) return;
      const endTrim = Math.min(
        start + masterDurationRef.current,
        pendingLoop.duration
      );
      const newLoop: Loop = {
        id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
        videoUri: pendingLoop.uri,
        duration: pendingLoop.duration,
        startTrim: start,
        endTrim,
        waveformData: pendingLoop.waveformData,
        layerIndex: loops.length,
        volume: Math.max(0, Math.min(1, layerVolume)),
        muted: false,
        videoOpacity: 0.85,
        fullRecordingUri: pendingLoop.fullRecordingUri ?? pendingLoop.uri,
        fullRecordingDuration: pendingLoop.fullRecordingDuration ?? pendingLoop.duration,
        bracketStartMs: start,
      };
      const updated = [...loops, newLoop];
      loopsRef.current = updated;
      setLoops(updated);
      saveLoops(updated);
      void syncLoopToServer(
        newLoop,
        masterDurationRef.current ?? 0,
        beatsRef.current,
        pendingLoop.detectedBpm ?? null
      );
      setPendingLoop(null);
      setPendingBracketMs(0);
      setPhase("playing");
      startPlayback(0);
    },
    [pendingLoop, pendingBracketMs, loops, saveLoops, startPlayback]
  );
  confirmBracketRef.current = confirmBracket;

  const nudgePendingBracket = useCallback((dir: -1 | 1) => {
    const md = masterDurationRef.current;
    const pending = pendingLoopRef.current;
    if (!md || !pending) return;
    setPendingBracketMs((cur) =>
      nudgeBracket(cur, dir, {
        duration: pending.duration,
        masterDuration: md,
        beatsPerLoop,
      })
    );
  }, [beatsPerLoop]);

  const setPendingBracket = useCallback((ms: number) => {
    const md = masterDurationRef.current;
    const pending = pendingLoopRef.current;
    if (!md || !pending || !Number.isFinite(ms)) return;
    const max = Math.max(0, pending.duration - md);
    setPendingBracketMs(Math.max(0, Math.min(max, ms)));
  }, []);

  const discardPending = useCallback(() => {
    if (pendingLoop) revokeBlobURI(pendingLoop.uri);
    setPendingLoop(null);
    setPendingBracketMs(0);
    setPhase(loops.length > 0 ? "playing" : "idle");
  }, [loops.length, pendingLoop]);

  const removeLoop = useCallback(
    (id: string) => {
      const loopToRemove = loops.find((l) => l.id === id);
      if (loopToRemove) {
        revokeBlobURI(loopToRemove.videoUri);
        revokeBlobURI(loopToRemove.fullRecordingUri);
      }
      const updated = loops
        .filter((l) => l.id !== id)
        .map((l, i) => ({ ...l, layerIndex: i }));
      setLoops(updated);
      saveLoops(updated);
      void deleteLoopFromServer(id);
      if (soloedId === id) setSoloedId(null);
      if (updated.length === 0) {
        setPhase("idle");
        setMasterDuration(null);
        masterDurationRef.current = null;
        clockPausedOffset.current = 0;
        stopPlayback();
        setBeatsPerLoopState(BEATS_DEFAULT);
        AsyncStorage.removeItem(STORAGE_KEY_MASTER).catch(() => {});
        AsyncStorage.removeItem(STORAGE_KEY_BEATS).catch(() => {});
      } else if (loopToRemove && loopToRemove.layerIndex === 0) {
        // The tempo-defining layer is gone — re-anchor the master to the
        // earliest remaining layer's trimmed length.
        const nextMaster = updated[0].endTrim - updated[0].startTrim;
        if (nextMaster > 0) {
          masterDurationRef.current = nextMaster;
          setMasterDuration(nextMaster);
          saveMasterDuration(nextMaster);
        }
      }
    },
    [loops, saveLoops, saveMasterDuration, soloedId, stopPlayback]
  );

  const updateLoopTrack = useCallback(
    (id: string, patch: TrackPatch) => {
      const updated = loops.map((l) =>
        l.id === id ? { ...l, ...patch } : l
      );
      setLoops(updated);
      persistLoops(updated);
    },
    [loops, persistLoops]
  );

  const startEditLoop = useCallback(
    (id: string) => {
      // Provisional commit before opening the studio.
      if (pendingLoopRef.current) {
        confirmBracketRef.current();
      }
      const loop = loops.find((l) => l.id === id);
      if (loop) setEditingLoop(loop);
    },
    [loops]
  );

  const confirmEditBracket = useCallback(
    (id: string, bracketStartMs: number) => {
      const md = masterDurationRef.current;
      if (!md || !Number.isFinite(bracketStartMs) || bracketStartMs < 0) return;
      const updated = loops.map((l) =>
        l.id === id
          ? { ...l, startTrim: bracketStartMs, endTrim: Math.min(bracketStartMs + md, l.duration), bracketStartMs }
          : l
      );
      setLoops(updated);
      saveLoops(updated);
      setEditingLoop(null);
    },
    [loops, saveLoops]
  );

  const cancelEditLoop = useCallback(() => setEditingLoop(null), []);

  const finalizeProject = useCallback(() => {
    // Provisional commit: saving keeps the pending take at its envelope.
    if (pendingLoopRef.current) {
      confirmBracketRef.current();
    }
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    saveLoops(loops);
    setPhase("finalized");
    startPlayback(0);
    setEditingLoop(null);
  }, [loops, saveLoops, startPlayback]);

  const clearAll = useCallback(() => {
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    if (disarmTimeoutRef.current) {
      clearTimeout(disarmTimeoutRef.current);
      disarmTimeoutRef.current = null;
    }
    loops.forEach((l) => {
      revokeBlobURI(l.videoUri);
      revokeBlobURI(l.fullRecordingUri);
    });
    if (pendingLoop) revokeBlobURI(pendingLoop.uri);
    flushPersist();
    setLoops([]);
    setPendingLoop(null);
    setPendingBracketMs(0);
    setPhase("idle");
    setRecordingDuration(0);
    setMasterDuration(null);
    masterDurationRef.current = null;
    clockPausedOffset.current = 0;
    stopPlayback();
    setBeatsPerLoopState(BEATS_DEFAULT);
    setEditingLoop(null);
    setSoloedId(null);
    saveLoops([]);
    sessionIdRef.current = null;
    AsyncStorage.removeItem(STORAGE_KEY_SESSION_ID).catch(() => {});
    AsyncStorage.removeItem(STORAGE_KEY_MASTER).catch(() => {});
    AsyncStorage.removeItem(STORAGE_KEY_BEATS).catch(() => {});
  }, [loops, pendingLoop, saveLoops, flushPersist, stopPlayback]);

  useEffect(() => () => { flushPersist(); stopClock(); }, [flushPersist, stopClock]);

  const value = React.useMemo(
    () => ({
      loops,
      phase,
      pendingLoop,
      recordingDuration,
      isGlobalPlaying,
      masterDuration,
      editingLoop,
      soloedId,
      monitorOn,
      setMonitorOn,
      maxLoops: MAX_LOOPS,
      beatsPerLoop,
      lockBeatsPerLoop,
      armRecording,
      disarmRecording,
      startRecording,
      stopAndMeasure,
      onRecordingComplete,
      onRecordingCompleteWithRaw,
      confirmLoop,
      confirmBracket,
      discardPending,
      pendingBracketMs,
      nudgePendingBracket,
      setPendingBracket,
      removeLoop,
      toggleGlobalPlayback,
      clearAll,
      startEditLoop,
      confirmEditBracket,
      cancelEditLoop,
      finalizeProject,
      updateLoopTrack,
      setSoloedId,
      getNextLoopBoundary,
      getPlaybackPosition,
      subscribePlayback,
      savedSessions,
      saveCurrentToSessions,
      loadSession,
    }),
    [
      loops,
      phase,
      pendingLoop,
      recordingDuration,
      isGlobalPlaying,
      masterDuration,
      editingLoop,
      soloedId,
      monitorOn,
      setMonitorOn,
      beatsPerLoop,
      lockBeatsPerLoop,
      armRecording,
      disarmRecording,
      startRecording,
      stopAndMeasure,
      onRecordingComplete,
      onRecordingCompleteWithRaw,
      confirmLoop,
      confirmBracket,
      discardPending,
      pendingBracketMs,
      nudgePendingBracket,
      setPendingBracket,
      removeLoop,
      toggleGlobalPlayback,
      clearAll,
      startEditLoop,
      confirmEditBracket,
      cancelEditLoop,
      finalizeProject,
      updateLoopTrack,
      setSoloedId,
      getNextLoopBoundary,
      getPlaybackPosition,
      subscribePlayback,
      savedSessions,
      saveCurrentToSessions,
      loadSession,
    ]
  );

  return (
    <LoopContext.Provider value={value}>
      {children}
    </LoopContext.Provider>
  );
}

export function useLoops() {
  const ctx = useContext(LoopContext);
  if (!ctx) throw new Error("useLoops must be used within LoopProvider");
  return ctx;
}
