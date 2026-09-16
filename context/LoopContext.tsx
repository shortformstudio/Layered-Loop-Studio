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
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import * as Haptics from "expo-haptics";
import { File } from "expo-file-system";
import { syntheticWaveform, type AudioAnalysis } from "@/utils/audio-analysis";
import { defaultBracketMs, nudgeBracket, clampBracketStart, clampTrimBounds } from "@/lib/loopModel";
import {
  reduceLoopIntent,
  logMachineEvent,
  type MachineState,
  type MachineEffect,
  type LoopIntent,
  type Transport,
  MAX_LOOPS as MACHINE_MAX_LOOPS,
} from "@/lib/loopMachine";
import { syncLoopToServer, deleteLoopFromServer, type SyncState } from "@/lib/loopSync";

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
  /** Sync state with the API server (G43) */
  syncState?: "pending" | "synced" | "failed";
}

export type Phase =
  | "idle"
  | "armed"       // armed — yellow light, waiting for next loop boundary
  | "recording"   // actively recording
  | "trimming"    // first loop — choose trim bounds
  | "browsing"    // subsequent loop — choose bracket within recording
  | "playing"
  | "finalized"
  | "recovering"; // loops exist but masterDuration is missing/corrupt (G09)

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
  startTrim?: number;
  endTrim?: number;
  bracketStartMs?: number;
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
  /** Recover from a corrupt hydration — re-trims layer 0 as master. */
  enterRecoveryTrim: () => void;
  /** Last rejected intent reason — rendered as a toast by consumers. */
  lastRejected: string | null;
  /** Clear the last rejected reason after displaying it. */
  clearRejected: () => void;
  /** Reset iOS/Android audio session to clean background/speaker playback mode */
  restorePlaybackAudioMode: () => Promise<void>;
}

const LoopContext = createContext<LoopContextType | null>(null);

const MAX_LOOPS = 5;
const STORAGE_KEY = "looplayer_loops_v3";
const STORAGE_KEY_MASTER = "looplayer_master_duration";
const STORAGE_KEY_MONITOR = "looplayer_monitor_on";
const STORAGE_KEY_BEATS = "looplayer_beats_per_loop";
const STORAGE_KEY_SESSIONS = "looplayer_saved_sessions";
const STORAGE_KEY_SESSION_ID = "looplayer_session_id";
const STORAGE_KEY_PENDING = "looplayer_pending_loop";

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
  const pendingBracketMsRef = useRef(pendingBracketMs);
  pendingBracketMsRef.current = pendingBracketMs;
  const [savedSessions, setSavedSessions] = useState<SavedSession[]>([]);
  const [lastRejected, setLastRejected] = useState<string | null>(null);
  const clearRejected = useCallback(() => setLastRejected(null), []);

  // Refs mirroring state for callbacks that must stay dependency-light.
  const loopsRef = useRef<Loop[]>([]);
  loopsRef.current = loops;
  const pendingLoopRef = useRef<PendingLoop | null>(null);
  pendingLoopRef.current = pendingLoop;
  const beatsRef = useRef(beatsPerLoop);
  beatsRef.current = beatsPerLoop;
  const sessionIdRef = useRef<string | null>(null);
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

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
  const disarmRecordingRef = useRef<() => void>(() => {});

  // ── Shared playback clock ──────────────────────────────────────────────
  // One epoch anchors every layer. Position = (now − epoch) % masterDuration.
  // On pause the residual offset is preserved so play resumes mid-phrase
  // without any timeline adjustment.
  const clockEpoch = useRef<number>(0);
  const clockPausedOffset = useRef<number>(0);
  const clockTickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const clockSubscribers = useRef<Set<(positionMs: number) => void>>(new Set());
  const transportRef = useRef<Transport>("running");
  transportRef.current = clockTickTimer.current ? "running" : "paused";

  // ── Machine dispatch & effect execution ────────────────────────────
  const dispatchRef = useRef<(intent: LoopIntent) => boolean>(() => false);

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

  const restorePlaybackAudioMode = useCallback(async () => {
    if (Platform.OS === "web") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false,
        playsInSilentModeIOS: true,
        staysActiveInBackground: false,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        shouldDuckAndroid: false,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        playThroughEarpieceAndroid: false,
      });
    } catch (err) {
      console.warn("[audio] restore playback mode failed:", err);
    }
  }, []);

  const setMonitorOn = useCallback((v: boolean) => {
    setMonitorOnState(v);
    AsyncStorage.setItem(STORAGE_KEY_MONITOR, String(v)).catch(() => {});
  }, []);

  const saveLoops = useCallback((updated: Loop[]) => {
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
  }, []);

  const saveMasterDuration = useCallback((dur: number) => {
    AsyncStorage.setItem(STORAGE_KEY_MASTER, String(dur)).catch(() => {});
  }, []);

  const updateSyncState = useCallback((loopId: string, state: SyncState) => {
    const updated = loopsRef.current.map((l) =>
      l.id === loopId ? { ...l, syncState: state } : l
    );
    loopsRef.current = updated;
    setLoops(updated);
    AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(updated)).catch(() => {});
  }, []);

  const executeEffect = useCallback(
    (effect: MachineEffect) => {
      switch (effect.type) {
        case "START_CLOCK":
          startPlayback(effect.fromPositionMs);
          break;
        case "STOP_CLOCK":
          stopPlayback();
          break;
        case "SAVE_LOOPS":
          saveLoops(effect.loops);
          break;
        case "SAVE_MASTER":
          saveMasterDuration(effect.duration);
          break;
        case "CLEAR_MASTER":
          AsyncStorage.removeItem(STORAGE_KEY_MASTER).catch(() => {});
          AsyncStorage.removeItem(STORAGE_KEY_BEATS).catch(() => {});
          break;
        case "SYNC_LOOP":
          syncLoopToServer(effect.loop, effect.masterDuration, effect.beatsPerLoop, effect.detectedBpm)
            .then((state) => updateSyncState(effect.loop.id, state));
          break;
        case "DELETE_SERVER_LOOP":
          void deleteLoopFromServer(effect.id);
          break;
        case "REVOKE_BLOB":
          revokeBlobURI(effect.uri);
          break;
        case "SET_DISARM_TIMER":
          if (disarmTimeoutRef.current) clearTimeout(disarmTimeoutRef.current);
          disarmTimeoutRef.current = setTimeout(() => {
            if (phaseRef.current === "armed") {
              dispatchRef.current({ type: "DISARM" });
            }
          }, effect.ms);
          break;
        case "CLEAR_DISARM_TIMER":
          if (disarmTimeoutRef.current) {
            clearTimeout(disarmTimeoutRef.current);
            disarmTimeoutRef.current = null;
          }
          break;
        case "HAPTIC_SUCCESS":
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
          break;
        case "HAPTIC_WARNING":
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(() => {});
          break;
        case "SHOW_TOAST":
          setLastRejected(effect.message);
          break;
      }
    },
    [saveLoops, saveMasterDuration, startPlayback, stopPlayback, updateSyncState]
  );

  const buildMachineState = useCallback((): MachineState => ({
    phase: phaseRef.current,
    transport: transportRef.current,
    loops: loopsRef.current,
    pendingLoop: pendingLoopRef.current,
    masterDuration: masterDurationRef.current,
    editingLoop: null,
    recordingDuration: 0,
  }), []);

  const dispatch = useCallback(
    (intent: LoopIntent): boolean => {
      const prev = buildMachineState();
      const result = reduceLoopIntent(intent, prev, beatsRef.current, clockTickTimer.current !== null);
      if (result.rejected) {
        setLastRejected(result.rejected);
        logMachineEvent(intent.type, prev.phase, prev.phase, result.rejected);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(() => {});
        return false;
      }
      logMachineEvent(intent.type, prev.phase, result.state.phase);

      setPhase(result.state.phase);
      phaseRef.current = result.state.phase;

      setLoops(result.state.loops);
      loopsRef.current = result.state.loops;

      setPendingLoop(result.state.pendingLoop);
      pendingLoopRef.current = result.state.pendingLoop;

      setMasterDuration(result.state.masterDuration);
      masterDurationRef.current = result.state.masterDuration;

      setEditingLoop(result.state.editingLoop);
      setRecordingDuration(result.state.recordingDuration);
      setIsGlobalPlaying(result.state.transport === "running");

      result.effects.forEach(executeEffect);
      return true;
    },
    [buildMachineState, executeEffect]
  );
  dispatchRef.current = dispatch;

  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_KEY),
      AsyncStorage.getItem(STORAGE_KEY_MASTER),
      AsyncStorage.getItem(STORAGE_KEY_MONITOR),
      AsyncStorage.getItem(STORAGE_KEY_BEATS),
      AsyncStorage.getItem(STORAGE_KEY_SESSIONS),
      AsyncStorage.getItem(STORAGE_KEY_SESSION_ID),
      AsyncStorage.getItem(STORAGE_KEY_PENDING),
    ])
      .then(([rawLoops, rawMaster, rawMonitor, rawBeats, rawSessions, rawSessionId, rawPending]) => {
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
        // Cross-validation (G09): loops exist but masterDuration is missing
        // or corrupt → enter recovering phase instead of a frozen playing.
        if (hydratedLoops && masterDurationRef.current === null) {
          setPhase("recovering");
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
        // Restore pending take from last session (G22).
        if (rawPending && !hydratedLoops) {
          try {
            const pending = JSON.parse(rawPending) as PendingLoop;
            if (pending.uri && pending.duration > 0) {
              // On web, blob URIs die on reload — don't restore them.
              if (Platform.OS !== "web" || !pending.uri.startsWith("blob:")) {
                setPendingLoop(pending);
                setPendingBracketMs(pending.duration > 0 ? Math.max(0, pending.duration - (masterDurationRef.current ?? 0)) : 0);
                setPhase(masterDurationRef.current === null ? "trimming" : "browsing");
              }
            }
          } catch {
            /* corrupt pending — ignore */
          }
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

  // Persist pendingLoop on every change (G22).
  useEffect(() => {
    if (pendingLoop) {
      AsyncStorage.setItem(STORAGE_KEY_PENDING, JSON.stringify(pendingLoop)).catch(() => {});
    } else {
      AsyncStorage.removeItem(STORAGE_KEY_PENDING).catch(() => {});
    }
  }, [pendingLoop]);

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
      // Revoke blob URIs from the previous project before replacing. (G14 fix.)
      for (const l of loopsRef.current) {
        revokeBlobURI(l.videoUri);
        revokeBlobURI(l.fullRecordingUri);
      }
      if (pendingLoopRef.current) revokeBlobURI(pendingLoopRef.current.uri);
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
    return dispatch({ type: "ARM" });
  }, [dispatch]);

  const disarmRecording = useCallback(() => {
    dispatch({ type: "DISARM" });
  }, [dispatch]);
  disarmRecordingRef.current = disarmRecording;

  const startRecording = useCallback(() => {
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    const ok = dispatch({ type: "START_RECORDING" });
    if (!ok) return;
    recordingStartTime.current = Date.now();
    recordingTimer.current = setInterval(() => {
      setRecordingDuration(Date.now() - recordingStartTime.current);
    }, 500);
  }, [dispatch]);

  const stopAndMeasure = useCallback((): number => {
    if (recordingStartTime.current === 0) return 0;
    const elapsed = Date.now() - recordingStartTime.current;
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    dispatch({ type: "STOP_RECORDING", durationMs: elapsed });
    return elapsed;
  }, [dispatch]);

  const onRecordingComplete = useCallback(
    (uri: string, durationMs: number, analysis?: Partial<AudioAnalysis>) => {
      const waveformData = analysis?.waveformData ?? syntheticWaveform(uri + durationMs);
      dispatch({
        type: "RECORDING_COMPLETE",
        uri,
        durationMs,
        waveformData,
        detectedBpm: analysis?.bpm ?? null,
      });
      setPendingBracketMs(defaultBracketMs(durationMs, masterDurationRef.current ?? 0));
    },
    [dispatch]
  );

  const onRecordingCompleteWithRaw = useCallback(
    (
      uri: string,
      durationMs: number,
      rawUri: string,
      rawDuration: number,
      analysis?: Partial<AudioAnalysis>
    ) => {
      const waveformData = analysis?.waveformData ?? syntheticWaveform(uri + durationMs);
      dispatch({
        type: "RECORDING_COMPLETE",
        uri,
        durationMs,
        rawUri,
        rawDuration,
        waveformData,
        detectedBpm: analysis?.bpm ?? null,
      });
      setPendingBracketMs(defaultBracketMs(durationMs, masterDurationRef.current ?? 0));
    },
    [dispatch]
  );

  const confirmLoop = useCallback(
    (startTrim: number, endTrim: number) => {
      dispatch({ type: "CONFIRM_TRIM", startTrim, endTrim });
    },
    [dispatch]
  );

  const confirmBracket = useCallback(
    (bracketStartMs?: number, layerVolume = 1) => {
      const pos = bracketStartMs ?? pendingBracketMsRef.current;
      dispatch({ type: "CONFIRM_BRACKET", bracketStartMs: pos, volume: layerVolume });
    },
    [dispatch]
  );
  confirmBracketRef.current = confirmBracket;

  const nudgePendingBracket = useCallback(
    (dir: -1 | 1) => {
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
    },
    [beatsPerLoop]
  );

  const setPendingBracket = useCallback((ms: number) => {
    const md = masterDurationRef.current;
    const pending = pendingLoopRef.current;
    if (!md || !pending || !Number.isFinite(ms)) return;
    const max = Math.max(0, pending.duration - md);
    setPendingBracketMs(Math.max(0, Math.min(max, ms)));
  }, []);

  const discardPending = useCallback(() => {
    dispatch({ type: "DISCARD_PENDING" });
    setPendingBracketMs(0);
  }, [dispatch]);

  const removeLoop = useCallback(
    (id: string) => {
      dispatch({ type: "REMOVE_LOOP", id });
      if (soloedId === id) setSoloedId(null);
    },
    [dispatch, soloedId]
  );

  const toggleGlobalPlayback = useCallback(() => {
    dispatch({ type: "TOGGLE_PLAYBACK" });
  }, [dispatch]);

  const updateLoopTrack = useCallback(
    (id: string, patch: TrackPatch) => {
      const updated = loopsRef.current.map((l) =>
        l.id === id ? { ...l, ...patch } : l
      );
      setLoops(updated);
      persistLoops(updated);
    },
    [persistLoops]
  );

  const startEditLoop = useCallback(
    (id: string) => {
      dispatch({ type: "EDIT_LOOP", id });
    },
    [dispatch]
  );

  const confirmEditBracket = useCallback(
    (id: string, bracketStartMs: number) => {
      dispatch({ type: "CONFIRM_EDIT", id, bracketStartMs });
    },
    [dispatch]
  );

  const cancelEditLoop = useCallback(() => {
    dispatch({ type: "CANCEL_EDIT" });
  }, [dispatch]);

  const enterRecoveryTrim = useCallback(() => {
    dispatch({ type: "RECOVER" });
  }, [dispatch]);

  const finalizeProject = useCallback(() => {
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    dispatch({ type: "FINALIZE" });
  }, [dispatch]);

  const clearAll = useCallback(() => {
    if (recordingTimer.current) {
      clearInterval(recordingTimer.current);
      recordingTimer.current = null;
    }
    dispatch({ type: "CLEAR_ALL" });
    sessionIdRef.current = null;
    AsyncStorage.removeItem(STORAGE_KEY_SESSION_ID).catch(() => {});
    AsyncStorage.removeItem(STORAGE_KEY_PENDING).catch(() => {});
  }, [dispatch]);

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
      enterRecoveryTrim,
      lastRejected,
      clearRejected,
      restorePlaybackAudioMode,
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
      enterRecoveryTrim,
      lastRejected,
      clearRejected,
      restorePlaybackAudioMode,
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
