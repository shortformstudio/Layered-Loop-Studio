import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  useReducedMotion,
  withTiming,
  withSequence,
} from "react-native-reanimated";
import { CameraView, useCameraPermissions, useMicrophonePermissions } from "expo-camera";
import { Audio, AudioMode, InterruptionModeAndroid, InterruptionModeIOS } from "expo-av";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as FileSystemLegacy from "expo-file-system/legacy";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router, useLocalSearchParams } from "expo-router";
import * as Haptics from "expo-haptics";

import { WebRecorder } from "@/utils/web-recording";
import { analyzeAudio } from "@/utils/audio-analysis";

import { useLoops } from "@/context/LoopContext";
import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";
import VideoStack from "@/components/VideoStack";
import RecordButton from "@/components/RecordButton";
import ArmRing from "@/components/ArmRing";
import TrimEditor from "@/components/TrimEditor";
import TimelineBrowser from "@/components/TimelineBrowser";
import StackedTimeline from "@/components/StackedTimeline";
import Metronome from "@/components/Metronome";
import EnvelopeDock from "@/components/EnvelopeDock";
import MonitorCompact from "@/components/MonitorCompact";
import MonitorSheet, { type MonitorRoute } from "@/components/MonitorSheet";
import LiveRecordTimeline from "@/components/LiveRecordTimeline";
import VerticalFader from "@/components/VerticalFader";
import ExportPanel from "@/components/studio/ExportPanel";
import { loopPositionLabel } from "@/lib/loopModel";

const NAVY_BG = "#0A0D14";
/** Estimated bytes/second while recording (hvc1 1080p + audio). */
const BYTES_PER_SEC_ESTIMATE = 550_000;
const LOW_STORAGE_MINUTES = 10;

const BEATS_OPTIONS = [2, 4, 8, 16] as const;

/** Fire the armed trigger this far before the boundary — the camera takes a
 *  moment to spin up, so the recording lands on the downbeat. */
const ARM_TRIGGER_LEAD_MS = 130;

const STORAGE_MONITOR_ROUTE = "looplayer_monitor_route";
const STORAGE_MONITOR_VOLUME = "looplayer_monitor_volume";

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  const min = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = (s % 60).toString().padStart(2, "0");
  return `${min}:${sec}`;
}

function TopBtn({
  onPress,
  name,
  color,
  label,
}: {
  onPress: () => void;
  name: keyof typeof Ionicons.glyphMap;
  color: string;
  label: string;
}) {
  const colors = useColors();
  return (
    <TouchableOpacity
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={8}
      style={[topS.btn, { borderColor: colors.border }]}
    >
      <Ionicons name={name} size={17} color={color} />
    </TouchableOpacity>
  );
}
const topS = StyleSheet.create({
  btn: {
    width: 32,
    height: 32,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});

function SheetHeader({
  title,
  subtitle,
  onClose,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
}) {
  const colors = useColors();
  return (
    <View style={[shH.row, { borderBottomColor: colors.border }]}>
      <TouchableOpacity onPress={onClose} style={shH.close}>
        <Ionicons name="close" size={22} color={colors.foreground} />
      </TouchableOpacity>
      <View style={shH.center}>
        <Text style={[shH.title, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[shH.sub, { fontFamily: font.thin, color: colors.mutedForeground }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      <View style={{ width: 40 }} />
    </View>
  );
}
const shH = StyleSheet.create({
  row: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", gap: 2 },
  title: { fontSize: 13 },
  sub: { fontSize: 12 },
});

type RatioKind = "1:1" | "4:5" | "9:16";

const RATIO_MAP: Record<RatioKind, "1:1" | "4:3" | "16:9"> = {
  "1:1": "1:1",
  "4:5": "4:3",
  "9:16": "16:9",
};

export default function CameraScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { ratio: paramRatio } = useLocalSearchParams<{ ratio?: RatioKind }>();
  if (__DEV__) console.log("[camera] CameraScreen render — phase booting");

  const {
    loops, phase, pendingLoop, recordingDuration,
    isGlobalPlaying, masterDuration, editingLoop, soloedId,
    monitorOn, setMonitorOn,
    startRecording, stopAndMeasure, onRecordingComplete,
    onRecordingCompleteWithRaw,
    confirmLoop, confirmBracket,
    discardPending, removeLoop, toggleGlobalPlayback,
    clearAll, maxLoops, startEditLoop, confirmEditBracket,
    cancelEditLoop, armRecording, disarmRecording,
    getNextLoopBoundary, finalizeProject, updateLoopTrack,
    setSoloedId, beatsPerLoop, lockBeatsPerLoop,
    subscribePlayback, getPlaybackPosition, pendingBracketMs, setPendingBracket,
  } = useLoops();

  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [facing, setFacing] = useState<"front" | "back">("back");
  const recordingActive = useRef(false);
  const stopFlag = useRef(false);
  const cameraReady = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const webRecorderRef = useRef<WebRecorder | null>(null);
  /** True once the audio session is in play-and-record mode (overdub). */
  const audioRecordMode = useRef(false);
  /** Serializes all audio-mode changes — concurrent setAudioModeAsync calls
   *  crash on iOS. Every caller goes through this chain. */
  const audioModeChain = useRef<Promise<void>>(Promise.resolve());

  const queueAudioMode = useCallback((mode: AudioMode) => {
    const next = audioModeChain.current
      .catch(() => {})
      .then(() => Audio.setAudioModeAsync(mode).catch(() => {}));
    audioModeChain.current = next;
    return next;
  }, []);

  const [showExport, setShowExport] = useState(false);
  const [monitorVolume, setMonitorVolume] = useState(0.85);
  const [monitorRoute, setMonitorRoute] = useState<MonitorRoute>("auto");
  const [monitorSheetOpen, setMonitorSheetOpen] = useState(false);
  const [browseExpanded, setBrowseExpanded] = useState(false);
  const [beatFlashKey, setBeatFlashKey] = useState(0);
  const beatIdxRef = useRef(-1);

  // Armed visualization — the remaining segment of the master loop, lit.
  const [armRemainingFrac, setArmRemainingFrac] = useState(0);
  const armTriggeredRef = useRef(false);

  // BPM is derived from the master loop — strictly read-only.
  const bpm = masterDuration
    ? Math.round((beatsPerLoop * 60_000) / masterDuration)
    : null;

  const focusOpacity = useSharedValue(0);
  const focusScale = useSharedValue(1.5);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const focusAnimStyle = useAnimatedStyle(() => ({
    opacity: focusOpacity.value,
    transform: [{ scale: focusScale.value }],
  }));

  // Live take timeline — web feeds real analyser levels, native fills by time.
  const [liveLevels, setLiveLevels] = useState<number[]>([]);
  const liveLevelsRef = useRef<number[]>([]);
  const cameraFrameSize = useRef({ w: 0, h: 0 });

  // Storage headroom — free bytes → remaining record time estimate.
  const [storageInfo, setStorageInfo] = useState<{ freeBytes: number } | null>(null);
  useEffect(() => {
    if (Platform.OS === "web") return;
    let alive = true;
    const tick = () => {
      FileSystemLegacy.getFreeDiskStorageAsync()
        .then((bytes) => {
          if (alive && Number.isFinite(bytes)) setStorageInfo({ freeBytes: bytes });
        })
        .catch(() => {});
    };
    tick();
    const t = setInterval(tick, 10_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const storageMinutes =
    storageInfo && storageInfo.freeBytes > 0
      ? storageInfo.freeBytes / BYTES_PER_SEC_ESTIMATE / 60
      : null;
  const storageLow = storageMinutes !== null && storageMinutes < LOW_STORAGE_MINUTES;
  const storageText = storageMinutes === null
    ? null
    : storageMinutes >= 60
      ? `${Math.round(storageMinutes / 60)}h+ of recording space`
      : `~${Math.max(1, Math.round(storageMinutes))} min of recording space`;

  const triggerFocusIndicator = useCallback((x: number, y: number) => {
    setFocusPoint({ x, y });
    focusOpacity.value = 1;
    focusScale.value = 1.5;
    focusOpacity.value = withSequence(
      withTiming(1, { duration: 80 }),
      withTiming(0, { duration: 600 }),
    );
    focusScale.value = withTiming(0.6, { duration: 600 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    // expo-camera v17 removed programmatic focus — autofocus="on" keeps the
    // lens locked continuously; the ring confirms the tap visually.
  }, [focusOpacity, focusScale]);

  // Audio session: playback mode by default. The session moves to
  // play-and-record only while overdubbing, and stays there between takes so
  // playback is interrupted once per session instead of twice per take.
  // CRITICAL: never touch the session while recording — concurrent
  // setAudioModeAsync calls crash iOS. Changes queue and apply after the
  // take ends (volume is applied directly to VideoStack, no session needed).
  // The FIRST application is deferred to onCameraReady so the mode call
  // never races CameraView's capture-session startup (native crash on iOS).
  const applyAudioMode = useCallback(() => {
    queueAudioMode({
      allowsRecordingIOS: audioRecordMode.current,
      playsInSilentModeIOS: true,
      staysActiveInBackground: false,
      interruptionModeIOS: monitorOn
        ? InterruptionModeIOS.DoNotMix
        : InterruptionModeIOS.DuckOthers,
      shouldDuckAndroid: !monitorOn,
      interruptionModeAndroid: monitorOn
        ? InterruptionModeAndroid.DoNotMix
        : InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: monitorRoute === "earpiece",
    });
  }, [monitorOn, monitorRoute, queueAudioMode]);

  const applyAudioModeRef = useRef<() => void>(() => {});
  applyAudioModeRef.current = applyAudioMode;

  const audioModeSkippedFirst = useRef(false);
  useEffect(() => {
    if (!audioModeSkippedFirst.current) {
      audioModeSkippedFirst.current = true;
      return;
    }
    if (phase === "recording") return;
    applyAudioMode();
  }, [applyAudioMode, phase]);

  // Persisted monitor preferences — volume + verified route.
  useEffect(() => {
    Promise.all([
      AsyncStorage.getItem(STORAGE_MONITOR_ROUTE),
      AsyncStorage.getItem(STORAGE_MONITOR_VOLUME),
    ])
      .then(([rawRoute, rawVol]) => {
        if (rawRoute) {
          const valid: MonitorRoute[] = ["auto", "headphones", "bluetooth", "speaker", "earpiece"];
          if (valid.includes(rawRoute as MonitorRoute)) {
            setMonitorRoute(rawRoute as MonitorRoute);
          }
        }
        if (rawVol) {
          const v = parseFloat(rawVol);
          if (Number.isFinite(v)) setMonitorVolume(Math.max(0, Math.min(1, v)));
        }
      })
      .catch(() => {});
  }, []);

  const setMonitorRoutePersist = (route: MonitorRoute) => {
    setMonitorRoute(route);
    AsyncStorage.setItem(STORAGE_MONITOR_ROUTE, route).catch(() => {});
  };

  const setMonitorVolumePersist = (v: number) => {
    setMonitorVolume(v);
    AsyncStorage.setItem(STORAGE_MONITOR_VOLUME, String(v)).catch(() => {});
  };

  const beginRecording = useCallback(async () => {
    if (recordingActive.current) return;
    recordingActive.current = true;
    stopFlag.current = false;
    startRecording();
    liveLevelsRef.current = [];
    setLiveLevels([]);

    if (Platform.OS === "web") {
      try {
        // Camera warm-up gate (G23): retry with a short poll instead of throwing.
        if (!cameraReady.current) {
          for (let i = 0; i < 8; i++) {
            await new Promise((r) => setTimeout(r, 250));
            if (cameraReady.current) break;
          }
          if (!cameraReady.current) {
            throw new Error("Camera stream not ready. Wait a moment and try again.");
          }
        }
        const videoEl = document.querySelector<HTMLVideoElement>(
          '[data-role="camera-preview"] video'
        );
        if (!videoEl || !videoEl.srcObject) {
          throw new Error("Camera stream not ready. Refresh the page and re-grant camera permissions.");
        }
        const recorder = new WebRecorder();
        webRecorderRef.current = recorder;
        recorder.onLevel = (v) => {
          liveLevelsRef.current.push(v);
          if (liveLevelsRef.current.length % 3 === 0) {
            setLiveLevels(liveLevelsRef.current.slice(-96));
          }
        };
        const result = await recorder.start(videoEl, { maxDuration: 300 });
        webRecorderRef.current = null;
        const elapsed = stopAndMeasure();
        recordingActive.current = false;
        if (result?.uri && elapsed > 0) {
          const analysis = await analyzeAudio(result.uri).catch(() => undefined);
          onRecordingComplete(result.uri, elapsed, analysis);
        } else {
          disarmRecording();
          Alert.alert("Recording Error", "The recording was too short to use.");
        }
        stopFlag.current = false;
      } catch (e: unknown) {
        stopAndMeasure();
        recordingActive.current = false;
        webRecorderRef.current?.dispose();
        webRecorderRef.current = null;
        disarmRecording();
        if (!stopFlag.current) {
          const message = e instanceof Error ? e.message : "Recording failed unexpectedly.";
          Alert.alert("Recording Error", message);
        }
        stopFlag.current = false;
      }
      return;
    }

    try {
      // One category switch per overdub session: enter play-and-record mode
      // and stay there until the project resets. VideoStack's clock rail
      // drift-corrects every layer right after the switch settles.
      if (!audioRecordMode.current) {
        await queueAudioMode({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
          shouldDuckAndroid: false,
          interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
          playThroughEarpieceAndroid: monitorRoute === "earpiece",
        });
        audioRecordMode.current = true;
      }
      const result = await cameraRef.current?.recordAsync({
        maxDuration: 300,
        codec: Platform.OS === "ios" ? "hvc1" : undefined,
      });
      const elapsed = stopAndMeasure();
      recordingActive.current = false;
      if (result?.uri && elapsed > 0) {
        const analysis = await analyzeAudio(result.uri).catch(() => undefined);
        onRecordingComplete(result.uri, elapsed, analysis);
      } else {
        disarmRecording();
        Alert.alert("Recording Error", "The recording was too short to use.");
      }
    } catch (e) {
      stopAndMeasure();
      recordingActive.current = false;
      disarmRecording();
      if (!stopFlag.current) {
        const message = e instanceof Error ? e.message : "Recording failed unexpectedly.";
        Alert.alert("Recording Error", message);
      }
      stopFlag.current = false;
    }
  }, [startRecording, stopAndMeasure, onRecordingComplete, disarmRecording, queueAudioMode, monitorRoute]);

  useEffect(() => {
    return () => {
      if (recordingActive.current) {
        if (Platform.OS === "web") {
          webRecorderRef.current?.dispose();
          webRecorderRef.current = null;
        } else {
          Promise.resolve(cameraRef.current?.stopRecording()).catch(() => {});
        }
        stopAndMeasure();
        recordingActive.current = false;
        disarmRecording();
      }
      // Leave the record-enabled session behind — restoring playback mode
      // here would interrupt whatever is still playing.
    };
  }, [stopAndMeasure, disarmRecording]);

  const handleStartRecording = async () => {
    if (phase === "armed") return;
    // Permission auto-resume (G04): after granting, continue into arming/recording.
    if (!cameraPermission?.granted) {
      const result = await requestCameraPermission();
      if (!result.granted) return;
    }
    if (Platform.OS !== "web" && !micPermission?.granted) {
      const result = await requestMicPermission();
      // Mic denial is silent video — show banner, don't block. (G05)
      if (!result.granted) {
        // Continue anyway — silent video is better than dead-end.
      }
    }
    if (loops.length >= maxLoops) { Alert.alert("Max Loops", `Up to ${maxLoops} layers.`); return; }

    // If master tempo is set, arm and count-in to the next loop boundary —
    // playback keeps running the whole time (quantized overdub).
    if (masterDuration) {
      armForNextTake();
    } else {
      await beginRecording();
    }
  };

  // ── Navigation exit guard (G02, G03) ───────────────────────────────────
  // Never silently discard a take or armed state on back-navigation.
  const handleExit = useCallback(() => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (phase === "recording") {
      Alert.alert("Recording in progress", "Stop the recording before leaving.", [
        { text: "Stay", style: "cancel" },
        { text: "Stop & Leave", style: "destructive", onPress: () => {
          stopFlag.current = true;
          if (Platform.OS === "web") webRecorderRef.current?.stop();
          else Promise.resolve(cameraRef.current?.stopRecording()).catch(() => {});
          setTimeout(() => router.back(), 200);
        }},
      ]);
      return;
    }
    if (phase === "armed") {
      disarmRecording();
      router.back();
      return;
    }
    if (pendingLoop) {
      Alert.alert("Unsaved take", "You have an unconfirmed take.", [
        { text: "Stay", style: "cancel" },
        { text: "Discard & Leave", style: "destructive", onPress: () => {
          discardPending();
          router.back();
        }},
        { text: "Keep & Leave", onPress: () => {
          confirmBracket();
          router.back();
        }},
      ]);
      return;
    }
    if (router.canGoBack()) {
      router.back();
    } else {
      router.replace("/");
    }
  }, [phase, pendingLoop, disarmRecording, discardPending, confirmBracket]);

  // Arm the next take. The clock keeps running — the remaining loop glows
  // and recording begins as it closes (quantized overdub).
  const armForNextTake = useCallback(() => {
    if (!armRecording()) return;
    armTriggeredRef.current = false;
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
  }, [armRecording]);

  const handleRecordPress = async () => {
    if (phase === "recording") {
      stopFlag.current = true;
      if (Platform.OS === "web") {
        webRecorderRef.current?.stop();
      } else {
        try {
          await cameraRef.current?.stopRecording();
        } catch {
          /* recording already finished */
        }
      }
    } else if (phase === "armed") {
      disarmRecording();
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } else {
      await handleStartRecording();
    }
  };

  const handleArmTrigger = useCallback(async () => {
    if (phaseRef.current !== "armed") return;
    // Camera warm-up gate (G23): if the camera isn't ready yet, skip this
    // loop boundary — the armed state persists and the next boundary triggers.
    if (!cameraReady.current) {
      armTriggeredRef.current = false;
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    await beginRecording();
  }, [beginRecording]);

  const handleConfirmLoop = useCallback(
    (start: number, end: number, gridBeats: number | null) => {
      // Lock the beat grid before the master tempo is set — once D exists
      // the lock is a no-op and the BPM is fixed for the project.
      if (gridBeats && (BEATS_OPTIONS as readonly number[]).includes(gridBeats)) {
        lockBeatsPerLoop(gridBeats as (typeof BEATS_OPTIONS)[number]);
      }
      confirmLoop(start, end);
      // The loop starts playing and loops continuously. The next take is
      // armed by the musician — "next layer" — when they are ready.
    },
    [confirmLoop, lockBeatsPerLoop]
  );

  const handleBrowserConfirm = useCallback(
    (ms: number) => {
      confirmBracket(ms);
      // Kept: the stack keeps looping from the top. Arming the next take
      // waits for the musician's "next layer" press.
    },
    [confirmBracket]
  );

  const isRecording = phase === "recording";
  const isArmed = phase === "armed";
  const isTrimming = phase === "trimming";
  const isBrowsing = phase === "browsing";
  const isFinalized = phase === "finalized";
  const isPlaying = phase === "playing";

  // The armed count-in, rendered as light: the remaining segment of the
  // master loop glows and closes in toward the boundary — when it closes,
  // the recording begins.
  useEffect(() => {
    if (!isArmed || !masterDuration) {
      setArmRemainingFrac(0);
      return;
    }
    armTriggeredRef.current = false;
    const startPos = getPlaybackPosition() ?? 0;
    setArmRemainingFrac(Math.max(0, Math.min(1, 1 - startPos / masterDuration)));
    return subscribePlayback((pos) => {
      const remainingMs = masterDuration - pos;
      setArmRemainingFrac(Math.max(0, Math.min(1, remainingMs / masterDuration)));
      if (!armTriggeredRef.current && remainingMs <= ARM_TRIGGER_LEAD_MS) {
        armTriggeredRef.current = true;
        handleArmTrigger();
      }
    });
  }, [isArmed, masterDuration, subscribePlayback, getPlaybackPosition, handleArmTrigger]);

  const loopsPlaying = isRecording || isArmed || isBrowsing
    ? true
    : isGlobalPlaying && (isPlaying || isFinalized);

  const showCamera = isRecording || isArmed || loops.length === 0;
  const showStack = loops.length > 0;
  const canRecord = loops.length < maxLoops && !isTrimming && !isBrowsing && !isFinalized && !isArmed;

  useEffect(() => {
    if (!showCamera) cameraReady.current = false;
  }, [showCamera]);

  // Collapse the expanded envelope editor whenever the browsing phase ends.
  useEffect(() => {
    if (!isBrowsing) setBrowseExpanded(false);
  }, [isBrowsing]);

  // Downbeat pulse while recording — keeps the performer anchored to the
  // grid with a light haptic and a gold flash on the record button.
  useEffect(() => {
    if (!isRecording) {
      beatIdxRef.current = -1;
      return;
    }
    if (!masterDuration) return;
    return subscribePlayback((pos) => {
      const beatMs = masterDuration / beatsPerLoop;
      const idx = Math.floor(pos / beatMs);
      if (idx === beatIdxRef.current) return;
      beatIdxRef.current = idx;
      if (idx % beatsPerLoop === 0) {
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        if (!reducedMotion) setBeatFlashKey((k) => k + 1);
      }
    });
  }, [isRecording, masterDuration, beatsPerLoop, subscribePlayback, reducedMotion]);

  const tapLayerActive =
    (isPlaying || isArmed || isRecording || isBrowsing) && !isFinalized;

  const handleTapCapture = () => {
    // One gesture per phase: playing→arm · armed→cancel · recording→stop ·
    // browsing→keep the take (confirmPending arms the next take in one tap).
    if (phase === "playing" && loops.length >= maxLoops) return;
    handleRecordPress();
  };

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom;
  const { width: screenW, height: screenH } = useWindowDimensions();
  // The camera frame is a rectangle whose TOP reaches just below the title.
  // Its BOTTOM stays where the original square's bottom sat — the space
  // underneath belongs to the layered timelines.
  const stageW = screenW - 24 - 128 - 20;
  const stageH = screenH - (topPad + 56) - (bottomPad + 204);
  const frameBottomMargin = Math.max(0, (stageH - stageW) / 2);

  if (!cameraPermission) {
    return (
      <View style={[perm.box, { backgroundColor: colors.background }]}>
        <Text style={[perm.text, { fontFamily: font.thin, color: colors.foreground }]}>
          Checking permissions...
        </Text>
      </View>
    );
  }
  if (!cameraPermission.granted) {
    return (
      <View style={[perm.box, { backgroundColor: colors.background, paddingTop: topPad + 16 }]}>
        <Ionicons name="camera-outline" size={44} color={colors.mutedForeground} />
        <Text style={[perm.title, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
          CAMERA ACCESS NEEDED
        </Text>
        <Text style={[perm.body, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          LoopLayer needs camera and microphone access to record your loops.
        </Text>
        <TouchableOpacity
          style={[perm.btn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
          onPress={async () => { await requestCameraPermission(); await requestMicPermission(); }}
        >
          <Text style={[perm.btnTxt, { fontFamily: font.thin, color: colors.primaryForeground }]}>
            Grant Access
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      {/* Video stack (z:2) — audio keeps playing while armed/recording, but
          the visuals drop away: the frame stays the dark camera stage. */}
      {showStack && (
        <View
          style={[
            StyleSheet.absoluteFill,
            { zIndex: 2 },
            (isRecording || isArmed) && { opacity: 0 },
          ]}
        >
          <VideoStack
            loops={loops}
            isPlaying={loopsPlaying}
            masterDuration={masterDuration}
            volume={monitorVolume}
            soloedId={soloedId}
          />
        </View>
      )}

      {/* Scrim (z:3) */}
      {showStack && !isRecording && !isArmed && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.15)", zIndex: 3 }]} />
      )}

      {/* Camera (z:10) — mounted only when needed so the session is
          released during playback (battery + camera indicator). The frame
          is a smaller square, flanked by the metronome rail (left) and the
          monitor rail (right), all enclosed in dark navy. The stage is
          fully opaque — the last loop's video stays behind it while the
          next take is armed or being recorded. */}
      {showCamera && (
        <View
          style={[
            styles.cameraStage,
            {
              zIndex: 10,
              backgroundColor: NAVY_BG,
              paddingTop: topPad + 56,
              paddingBottom: bottomPad + 204,
            },
          ]}
        >
          {/* LEFT RAIL — metronome visualizer */}
          <View style={styles.sideRail}>
            <Text style={[styles.railLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>
              metro
            </Text>
            <Metronome
              beatsPerLoop={beatsPerLoop}
              active={loopsPlaying}
              prominent={isRecording}
            />
            <Text style={[styles.railSub, { fontFamily: font.thin, color: colors.mutedForeground }]}>
              {masterDuration ? `${bpm ?? "—"} bpm` : "—"}
            </Text>
          </View>

          {/* CENTER — smaller square camera frame */}
          <View
            {...(Platform.OS === "web" ? { dataSet: { role: "camera-preview" } } : {})}
            onLayout={(e) => {
              cameraFrameSize.current = {
                w: e.nativeEvent.layout.width,
                h: e.nativeEvent.layout.height,
              };
            }}
            style={[styles.cameraFrame, { marginBottom: frameBottomMargin }]}
          >
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing={facing}
              mode="video"
              autofocus="on"
              ratio={paramRatio ? RATIO_MAP[paramRatio] : undefined}
              onCameraReady={() => {
                if (__DEV__) console.log("[camera] CameraView ready");
                cameraReady.current = true;
                applyAudioModeRef.current();
              }}
              onMountError={(e) => {
                if (__DEV__) console.log("[camera] CameraView mount error:", e?.message);
                cameraReady.current = false;
                disarmRecording();
                Alert.alert("Camera Error", e.message || "The camera could not be started.");
              }}
            />

            {/* Tap-to-focus surface — inside the camera frame */}
            {!isRecording && !isArmed && (
              <View
                style={StyleSheet.absoluteFill}
                onTouchEnd={(e) => {
                  const { locationX, locationY } = e.nativeEvent;
                  triggerFocusIndicator(locationX, locationY);
                }}
                pointerEvents="auto"
                importantForAccessibility="no-hide-descendants"
              />
            )}

            {focusPoint && !isRecording && (
              <Animated.View
                style={[
                  focusAnimStyle,
                  {
                    position: "absolute",
                    left: focusPoint.x - 44,
                    top: focusPoint.y - 44,
                    width: 88,
                    height: 88,
                    borderRadius: 44,
                    borderWidth: 2,
                    borderColor: colors.primary,
                    pointerEvents: "none",
                  },
                ]}
              />
            )}
          </View>

          {/* RIGHT RAIL — monitor device + volume */}
          <View style={styles.sideRail}>
            <Text style={[styles.railLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>
              monitor
            </Text>
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setMonitorSheetOpen(true);
              }}
              onLongPress={() => {
                setMonitorOn(!monitorOn);
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              }}
              style={[
                styles.railBtn,
                {
                  borderColor: monitorOn ? colors.primary : colors.border,
                  backgroundColor: monitorOn ? `${colors.primary}22` : "rgba(245,240,232,0.05)",
                },
              ]}
              accessibilityRole="button"
              accessibilityLabel="Monitor device settings"
            >
              <Ionicons
                name={monitorOn ? "headset" : "headset-outline"}
                size={20}
                color={monitorOn ? colors.primary : colors.mutedForeground}
              />
            </TouchableOpacity>
            <VerticalFader
              value={monitorVolume}
              onChange={setMonitorVolumePersist}
              height={160}
            />
            <Text style={[styles.railSub, { fontFamily: font.thin, color: colors.mutedForeground }]}>
              {Math.round(monitorVolume * 100)}%
            </Text>
          </View>
        </View>
      )}

      {/* Armed overlay — yellow glow */}
      {isArmed && masterDuration && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              zIndex: 19,
              backgroundColor: "rgba(226, 198, 68, 0.06)",
              borderWidth: 2,
              borderColor: colors.armedYellow,
              margin: 40,
              borderRadius: 8,
            },
          ]}
          pointerEvents="none"
        />
      )}

      {/* Tap-anywhere capture layer (z:20) — one gesture per phase */}
      {tapLayerActive && (
        <Pressable
          style={[StyleSheet.absoluteFill, { zIndex: 20 }]}
          onPress={handleTapCapture}
          accessibilityRole="button"
          accessibilityLabel={
            isBrowsing ? "Keep take and arm recording"
              : isArmed ? "Cancel recording"
                : isRecording ? "Stop recording"
                  : "Start recording"
          }
        />
      )}

      {/* TOP BAR (z:25) */}
      <View style={[styles.topBar, { paddingTop: topPad + 8, zIndex: 25 }]}>
        <View style={styles.topSide}>
          <TouchableOpacity
            onPress={handleExit}
            accessibilityRole="button"
            accessibilityLabel="Go back"
            hitSlop={8}
            style={[topS.btn, { borderColor: colors.border }]}
          >
            <Ionicons name="chevron-back" size={17} color="rgba(255,255,255,0.7)" />
          </TouchableOpacity>
          {loops.length > 0 && (
            <View style={styles.savedRow}>
              <Text style={[styles.layerCount, { fontFamily: font.thin, color: "rgba(255,255,255,0.65)" }]}>
                {loops.length}/{maxLoops}
              </Text>
              <View style={[styles.savedDot, { backgroundColor: colors.primary }]} />
            </View>
          )}
        </View>

        <View style={styles.topCenter}>
          {!isRecording && !isArmed && loops.length === 0 && (
            <Text style={[styles.wordmark, { fontFamily: font.thin, color: "#fff" }]}>
              LOOPLAYER
            </Text>
          )}
          {isRecording && (
            <Text
              style={[
                styles.timer,
                {
                  fontFamily: font.mono,
                  color: "#fff",
                  fontSize: masterDuration ? 13 : 18,
                },
              ]}
            >
              {masterDuration
                ? loopPositionLabel(recordingDuration, masterDuration, beatsPerLoop)
                : formatDuration(recordingDuration)}
            </Text>
          )}
          {isArmed && (
            <Text style={[styles.armedLabel, { fontFamily: font.thin, color: colors.armedYellow }]}>
              ARMED · WAITING...
            </Text>
          )}
          {!isRecording && !isArmed && isFinalized && (
            <Text style={[styles.tag, { fontFamily: font.thin, color: colors.primary }]}>
              FINALIZED
            </Text>
          )}
        </View>

        <View style={styles.topRight}>
          {loops.length > 0 && masterDuration && (
            <View style={styles.bpmBox}>
              <Text style={[styles.bpmVal, { fontFamily: font.mono, color: colors.primary }]}>
                {bpm ?? "—"}
              </Text>
              <Text style={[styles.bpmLabel, { fontFamily: font.thin, color: "rgba(255,255,255,0.6)" }]}>
                BPM
              </Text>
            </View>
          )}
          {loops.length > 0 && (
            <TopBtn
              name="share-outline"
              color="rgba(255,255,255,0.65)"
              label="Export project"
              onPress={() => { setShowExport(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            />
          )}
          {!isRecording && !isArmed && loops.length > 0 && (
            <TopBtn
              name="trash-outline"
              color="rgba(255,255,255,0.45)"
              label="Clear project"
              onPress={() => {
                const confirm = (done: () => void) => {
                  if (Platform.OS === "web") {
                    if (globalThis.confirm?.("Remove all loops and reset?")) done();
                  } else {
                    Alert.alert("Clear Project", "Remove all loops and reset?", [
                      { text: "Cancel", style: "cancel" },
                      { text: "Clear", style: "destructive", onPress: done },
                    ]);
                  }
                };
                confirm(clearAll);
              }}
            />
          )}
          {!isRecording && !isArmed && loops.length === 0 && (
            <TopBtn
              name="camera-reverse-outline"
              color="rgba(255,255,255,0.7)"
              label="Flip camera"
              onPress={() => { setFacing(f => f === "back" ? "front" : "back"); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }}
            />
          )}
        </View>
      </View>

      {/* BOTTOM CARD (z:22) — the single vertical column */}
      <View
        style={[
          styles.card,
          {
            backgroundColor: colors.overlayLight,
            paddingBottom: bottomPad + 16,
            borderTopColor: colors.border,
            zIndex: 22,
          },
        ]}
      >
        <View style={[styles.handle, { backgroundColor: colors.muted }]} />

        {/* Stacked tracks — root loop anchored at the bottom */}
        {loops.length > 0 && !isTrimming && !isBrowsing && (
          <StackedTimeline
            loops={loops}
            masterDuration={masterDuration}
            beatsPerLoop={beatsPerLoop}
            soloedId={soloedId}
            onEditLoop={(id) => { setShowExport(false); startEditLoop(id); }}
            onToggleMute={(id) => {
              const loop = loops.find(l => l.id === id);
              if (loop) updateLoopTrack(id, { muted: !loop.muted });
            }}
            onToggleSolo={(id) => setSoloedId(soloedId === id ? null : id)}
            onRemoveLoop={isFinalized ? () => {} : removeLoop}
          />
        )}

        {/* Envelope dock — provisional commit surface during browsing */}
        {isBrowsing && pendingLoop && masterDuration !== null && (
          <EnvelopeDock
            onExpand={() => setBrowseExpanded(true)}
            auditionActive={!browseExpanded}
            onKeep={() => handleBrowserConfirm(pendingBracketMs)}
          />
        )}

        {/* Transport: monitor · metronome · record · play/stop */}
        <View style={styles.controlRow}>
          <View style={styles.sideCell}>
            {!showCamera && loops.length > 0 && (
              <View style={styles.leftCluster}>
                <MonitorCompact
                  monitorOn={monitorOn}
                  route={monitorRoute}
                  onToggle={() => setMonitorOn(!monitorOn)}
                  onOpenSettings={() => setMonitorSheetOpen(true)}
                />
                <Metronome
                  beatsPerLoop={beatsPerLoop}
                  active={loopsPlaying}
                  prominent={isRecording}
                />
              </View>
            )}
          </View>

          {!isFinalized ? (
            <View style={styles.recordWrap}>
              <RecordButton
                isRecording={isRecording}
                isArmed={isArmed}
                beatFlashKey={beatFlashKey}
                onPress={handleRecordPress}
                disabled={!canRecord && !isRecording && !isArmed}
              />
              {isArmed && <ArmRing remainingFrac={armRemainingFrac} beats={beatsPerLoop} />}
            </View>
          ) : (
            <View style={[styles.finalIcon, { borderColor: colors.primary }]}>
              <Ionicons name="musical-notes" size={26} color={colors.primary} />
            </View>
          )}

          <View style={styles.sideCell}>
            {!isRecording && !isArmed && loops.length > 0 && (
              <TouchableOpacity
                onPress={toggleGlobalPlayback}
                style={[styles.iconBtn, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel={isGlobalPlaying ? "Stop playback" : "Play playback"}
              >
                <Ionicons name={isGlobalPlaying ? "stop" : "play"} size={18} color={colors.foreground} />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Next layer — below the core controls. Arms the next take while
            layers remain; saves the composition once the stack is full. */}
        {!isTrimming && !isBrowsing && !isArmed && !isRecording && loops.length > 0 && (
          <TouchableOpacity
            onPress={() => {
              if (isFinalized) return;
              if (loops.length >= maxLoops) {
                Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                finalizeProject();
              } else {
                armForNextTake();
              }
            }}
            style={[
              styles.saveBtn,
              {
                backgroundColor: isFinalized ? "transparent" : colors.primary,
                borderColor: colors.primary,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={loops.length >= maxLoops ? "Save project" : "Next layer"}
          >
            <Ionicons
              name={
                isFinalized
                  ? "checkmark"
                  : loops.length >= maxLoops
                    ? "save-outline"
                    : "arrow-forward"
              }
              size={16}
              color={isFinalized ? colors.primary : colors.primaryForeground}
            />
            <Text
              style={[
                styles.saveTxt,
                {
                  fontFamily: font.thin,
                  color: isFinalized ? colors.primary : colors.primaryForeground,
                },
              ]}
            >
              {isFinalized
                ? "saved · auto-stored"
                : loops.length >= maxLoops
                  ? "save"
                  : "next layer"}
            </Text>
          </TouchableOpacity>
        )}

        {/* Hint text */}
        <Text style={[styles.hint, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          {isRecording && loops.length === 0 && "recording freely — trim to set the master tempo"}
          {isRecording && loops.length > 0 && "recording — tap anywhere to stop and place your loop"}
          {isArmed && "armed — the rest of the loop is lit; recording begins as it closes (tap to cancel)"}
          {isBrowsing && "your take is already in the loop — nudge the envelope, or keep going"}
          {!isRecording && !isArmed && loops.length === 0 && "tap record to begin your first loop"}
          {!isRecording && !isArmed && !isBrowsing && !isFinalized && loops.length > 0 && loops.length < maxLoops
            && `${maxLoops - loops.length} layer${maxLoops - loops.length !== 1 ? "s" : ""} remaining · tap anywhere to record`}
          {!isRecording && !isArmed && !isBrowsing && !isFinalized && loops.length >= maxLoops && "all layers recorded · tap a track to re-trim"}
          {isFinalized && "composition saved · tap a track to re-trim"}
        </Text>
      </View>

      {/* MODALS */}
      <Modal
        visible={isTrimming && !!pendingLoop}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={discardPending}
      >
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <SheetHeader title="SET LOOP LENGTH" subtitle="This length becomes the master tempo" onClose={discardPending} />
          {pendingLoop && (
            <TrimEditor
              uri={pendingLoop.uri}
              duration={pendingLoop.duration}
              waveformData={pendingLoop.waveformData}
              detectedBpm={pendingLoop.detectedBpm}
              onConfirm={handleConfirmLoop}
              onDiscard={discardPending}
            />
          )}
        </View>
      </Modal>

      <Modal
        visible={browseExpanded && isBrowsing && !!pendingLoop}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setBrowseExpanded(false)}
      >
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <SheetHeader title="CHOOSE YOUR SECTION" subtitle={`Layer ${loops.length + 1} of ${maxLoops}`} onClose={() => setBrowseExpanded(false)} />
          {pendingLoop && masterDuration !== null && (
            <TimelineBrowser
              uri={pendingLoop.uri}
              duration={pendingLoop.duration}
              masterDuration={masterDuration}
              waveformData={pendingLoop.waveformData}
              loopNumber={loops.length + 1}
              bracketStartMs={pendingBracketMs}
              onBracketChange={setPendingBracket}
              beatsPerLoop={beatsPerLoop}
              syncWithClock
              confirmLabel="record next loop"
              onConfirm={(ms) => handleBrowserConfirm(ms)}
              onDiscard={discardPending}
            />
          )}
        </View>
      </Modal>

      <Modal
        visible={!!editingLoop}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={cancelEditLoop}
      >
        <View style={[styles.sheet, { backgroundColor: colors.background }]}>
          <SheetHeader
            title={`RE-EDIT LAYER ${editingLoop ? editingLoop.layerIndex + 1 : ""}`}
            subtitle="Slide the bracket to a new section"
            onClose={cancelEditLoop}
          />
          {editingLoop && masterDuration !== null && (
            <TimelineBrowser
              uri={editingLoop.fullRecordingUri || editingLoop.videoUri}
              duration={editingLoop.fullRecordingDuration || editingLoop.duration}
              masterDuration={masterDuration}
              waveformData={editingLoop.waveformData}
              loopNumber={editingLoop.layerIndex + 1}
              initialBracketStartMs={editingLoop.bracketStartMs}
              beatsPerLoop={beatsPerLoop}
              confirmLabel="Save Changes"
              volume={editingLoop.volume}
              onVolumeChange={(v) => updateLoopTrack(editingLoop.id, { volume: v })}
              onConfirm={(ms) => confirmEditBracket(editingLoop.id, ms)}
              onDiscard={cancelEditLoop}
            />
          )}
        </View>
      </Modal>

      <ExportPanel
        visible={showExport}
        loops={loops}
        onClose={() => setShowExport(false)}
      />

      <MonitorSheet
        visible={monitorSheetOpen}
        onClose={() => setMonitorSheetOpen(false)}
        monitorOn={monitorOn}
        onMonitorToggle={() => setMonitorOn(!monitorOn)}
        volume={monitorVolume}
        onVolumeChange={setMonitorVolumePersist}
        route={monitorRoute}
        onRouteChange={setMonitorRoutePersist}
        isRecording={isRecording}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: NAVY_BG },

  cameraStage: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingHorizontal: 12,
  },
  sideRail: {
    width: 64,
    alignItems: "center",
    justifyContent: "center",
    gap: 14,
  },
  railLabel: {
    fontSize: 9,
    letterSpacing: 2,
  },
  railSub: {
    fontSize: 11,
    letterSpacing: 0.5,
  },
  railBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  cameraFrame: {
    flex: 1,
    alignSelf: "stretch",
    overflow: "hidden",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.16)",
  },
  recordWrap: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
  },

  topBar: {
    position: "absolute", top: 0, left: 0, right: 0,
    flexDirection: "row", alignItems: "flex-start",
    paddingHorizontal: 12, paddingBottom: 10,
  },
  topSide: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10 },
  topCenter: { flex: 2, alignItems: "center" },
  topRight: { flex: 1, flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },

  wordmark: { fontSize: 13, letterSpacing: 6 },
  timer: { fontSize: 18 },
  armedLabel: { fontSize: 12, letterSpacing: 3 },
  tag: { fontSize: 11, letterSpacing: 2 },
  savedRow: { flexDirection: "row", alignItems: "center", gap: 5, paddingTop: 8 },
  savedDot: { width: 5, height: 5, borderRadius: 3 },
  layerCount: { fontSize: 13, letterSpacing: 1 },

  bpmBox: { alignItems: "center", paddingTop: 2 },
  bpmVal: { fontSize: 15, lineHeight: 17 },
  bpmLabel: { fontSize: 8, letterSpacing: 1.5 },

  card: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingTop: 8,
    gap: 10,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -4 },
    shadowOpacity: 0.10,
    shadowRadius: 20,
    elevation: 12,
  },
  handle: { width: 36, height: 3, borderRadius: 2, alignSelf: "center" },

  controlRow: {
    flexDirection: "row", alignItems: "center",
    justifyContent: "center", paddingHorizontal: 32,
  },
  sideCell: { flex: 1, alignItems: "center" },
  leftCluster: { flexDirection: "row", alignItems: "center", gap: 14 },

  iconBtn: {
    width: 42, height: 42, borderRadius: 21, borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  finalIcon: {
    width: 72, height: 72, borderRadius: 36, borderWidth: 1.5,
    alignItems: "center", justifyContent: "center",
  },

  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 14,
    borderWidth: 1,
    marginHorizontal: 32,
  },
  saveTxt: { fontSize: 14, letterSpacing: 2 },

  hint: { textAlign: "center", fontSize: 12, letterSpacing: 0.3, paddingHorizontal: 24 },

  sheet: { flex: 1 },
});

const perm = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 36 },
  title: { fontSize: 13, textAlign: "center" },
  body: { fontSize: 15, textAlign: "center", lineHeight: 22 },
  text: { fontSize: 15, textAlign: "center" },
  btn: { paddingHorizontal: 36, paddingVertical: 15, borderRadius: 14, marginTop: 8 },
  btnTxt: { fontSize: 16 },
});
