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
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
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
import VerticalFader from "@/components/VerticalFader";
import ExportPanel from "@/components/studio/ExportPanel";
import { loopPositionLabel } from "@/lib/loopModel";

const VOID_BG = "#060d06";
const BYTES_PER_SEC_ESTIMATE = 550_000;
const LOW_STORAGE_MINUTES = 10;
const BEATS_OPTIONS = [2, 4, 8, 16] as const;
const ARM_TRIGGER_LEAD_MS = 130;
const STORAGE_MONITOR_ROUTE = "aesthetic_monitor_route";
const STORAGE_MONITOR_VOLUME = "aesthetic_monitor_volume";

function formatDuration(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}

function GlassBtn({ onPress, name, color, label }: { onPress: () => void; name: keyof typeof Ionicons.glyphMap; color: string; label: string }) {
  return (
    <TouchableOpacity onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8}
      style={[gS.btn, { backgroundColor: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.06)" }]}>
      <Ionicons name={name} size={16} color={color} />
    </TouchableOpacity>
  );
}
const gS = StyleSheet.create({
  btn: { width: 32, height: 32, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
});

function SheetHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <View style={[shH.row, { borderBottomColor: "rgba(255,255,255,0.06)" }]}>
      <TouchableOpacity onPress={onClose} style={shH.close}>
        <Ionicons name="close" size={20} color="rgba(255,255,255,0.92)" />
      </TouchableOpacity>
      <View style={shH.center}>
        <Text style={[shH.title, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)", letterSpacing: tracking.wide }]}>{title}</Text>
        {subtitle ? <Text style={[shH.sub, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>{subtitle}</Text> : null}
      </View>
      <View style={{ width: 40 }} />
    </View>
  );
}
const shH = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth },
  close: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  center: { flex: 1, alignItems: "center", gap: 2 },
  title: { fontSize: 13 }, sub: { fontSize: 12 },
});

type RatioKind = "1:1" | "4:5" | "9:16";
const RATIO_MAP: Record<RatioKind, "1:1" | "4:3" | "16:9"> = { "1:1": "1:1", "4:5": "4:3", "9:16": "16:9" };

export default function CameraScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const { ratio: paramRatio } = useLocalSearchParams<{ ratio?: RatioKind }>();

  const {
    loops, phase, pendingLoop, recordingDuration,
    isGlobalPlaying, masterDuration, editingLoop, soloedId,
    monitorOn, setMonitorOn,
    startRecording, stopAndMeasure, onRecordingComplete,
    confirmLoop, confirmBracket,
    discardPending, removeLoop, toggleGlobalPlayback,
    clearAll, maxLoops, startEditLoop, confirmEditBracket,
    cancelEditLoop, armRecording, disarmRecording,
    finalizeProject, updateLoopTrack,
    setSoloedId, beatsPerLoop, lockBeatsPerLoop,
    subscribePlayback, getPlaybackPosition, pendingBracketMs, setPendingBracket,
  } = useLoops();

  const isNative = Platform.OS !== "web";
  const cameraRef = useRef<CameraView>(null);
  const [cameraPermission, requestCameraPermission] = useCameraPermissions();
  const [micPermission, requestMicPermission] = useMicrophonePermissions();
  const [facing, setFacing] = useState<"front" | "back">("back");
  const recordingActive = useRef(false);

  // Request camera + mic permissions on mount
  useEffect(() => {
    if (!cameraPermission?.granted) requestCameraPermission();
    if (Platform.OS !== "web" && !micPermission?.granted) requestMicPermission();
  }, []);
  const stopFlag = useRef(false);
  const cameraReady = useRef(false);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const webRecorderRef = useRef<WebRecorder | null>(null);
  const audioRecordMode = useRef(false);
  const audioModeChain = useRef<Promise<void>>(Promise.resolve());

  const queueAudioMode = useCallback((mode: AudioMode) => {
    const next = audioModeChain.current.catch(() => {}).then(() => Audio.setAudioModeAsync(mode).catch(() => {}));
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
  const [armRemainingFrac, setArmRemainingFrac] = useState(0);
  const armTriggeredRef = useRef(false);

  const bpm = masterDuration ? Math.round((beatsPerLoop * 60_000) / masterDuration) : null;

  const focusOpacity = useSharedValue(0);
  const focusScale = useSharedValue(1.5);
  const [focusPoint, setFocusPoint] = useState<{ x: number; y: number } | null>(null);
  const focusAnimStyle = useAnimatedStyle(() => ({ opacity: focusOpacity.value, transform: [{ scale: focusScale.value }] }));

  const [storageInfo, setStorageInfo] = useState<{ freeBytes: number } | null>(null);
  useEffect(() => {
    if (Platform.OS === "web") return;
    let alive = true;
    const tick = () => { FileSystemLegacy.getFreeDiskStorageAsync().then((bytes) => { if (alive && Number.isFinite(bytes)) setStorageInfo({ freeBytes: bytes }); }).catch(() => {}); };
    tick();
    const t = setInterval(tick, 10_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const triggerFocusIndicator = useCallback((x: number, y: number) => {
    setFocusPoint({ x, y });
    focusOpacity.value = 1; focusScale.value = 1.5;
    focusOpacity.value = withSequence(withTiming(1, { duration: 80 }), withTiming(0, { duration: 600 }));
    focusScale.value = withTiming(0.6, { duration: 600 });
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  }, [focusOpacity, focusScale]);

  const applyAudioMode = useCallback(() => {
    queueAudioMode({
      allowsRecordingIOS: audioRecordMode.current, playsInSilentModeIOS: true, staysActiveInBackground: false,
      interruptionModeIOS: monitorOn ? InterruptionModeIOS.DoNotMix : InterruptionModeIOS.DuckOthers,
      shouldDuckAndroid: !monitorOn,
      interruptionModeAndroid: monitorOn ? InterruptionModeAndroid.DoNotMix : InterruptionModeAndroid.DuckOthers,
      playThroughEarpieceAndroid: monitorRoute === "earpiece",
    });
  }, [monitorOn, monitorRoute, queueAudioMode]);

  const applyAudioModeRef = useRef<() => void>(() => {});
  applyAudioModeRef.current = applyAudioMode;

  const audioModeSkippedFirst = useRef(false);
  useEffect(() => {
    if (!audioModeSkippedFirst.current) { audioModeSkippedFirst.current = true; return; }
    if (phase === "recording") return;
    applyAudioMode();
  }, [applyAudioMode, phase]);

  useEffect(() => {
    Promise.all([AsyncStorage.getItem(STORAGE_MONITOR_ROUTE), AsyncStorage.getItem(STORAGE_MONITOR_VOLUME)])
      .then(([rawRoute, rawVol]) => {
        if (rawRoute) { const valid: MonitorRoute[] = ["auto", "headphones", "bluetooth", "speaker", "earpiece"]; if (valid.includes(rawRoute as MonitorRoute)) setMonitorRoute(rawRoute as MonitorRoute); }
        if (rawVol) { const v = parseFloat(rawVol); if (Number.isFinite(v)) setMonitorVolume(Math.max(0, Math.min(1, v))); }
      }).catch(() => {});
  }, []);

  const setMonitorRoutePersist = (route: MonitorRoute) => { setMonitorRoute(route); AsyncStorage.setItem(STORAGE_MONITOR_ROUTE, route).catch(() => {}); };
  const setMonitorVolumePersist = (v: number) => { setMonitorVolume(v); AsyncStorage.setItem(STORAGE_MONITOR_VOLUME, String(v)).catch(() => {}); };

  const beginRecording = useCallback(async () => {
    if (recordingActive.current) return;
    recordingActive.current = true; stopFlag.current = false; startRecording();
    if (Platform.OS === "web") {
      try {
        if (!cameraReady.current) throw new Error("Camera stream not ready.");
        const videoEl = document.querySelector<HTMLVideoElement>('[data-role="camera-preview"] video');
        if (!videoEl || !videoEl.srcObject) throw new Error("Camera stream not ready.");
        const recorder = new WebRecorder(); webRecorderRef.current = recorder;
        const result = await recorder.start(videoEl, { maxDuration: 300 });
        webRecorderRef.current = null;
        const elapsed = stopAndMeasure(); recordingActive.current = false;
        if (result?.uri && elapsed > 0) { const analysis = await analyzeAudio(result.uri).catch(() => undefined); onRecordingComplete(result.uri, elapsed, analysis); }
        else { disarmRecording(); Alert.alert("Recording Error", "Too short."); }
        stopFlag.current = false;
      } catch (e: unknown) { stopAndMeasure(); recordingActive.current = false; webRecorderRef.current?.dispose(); webRecorderRef.current = null; disarmRecording(); if (!stopFlag.current) Alert.alert("Recording Error", e instanceof Error ? e.message : "Failed."); stopFlag.current = false; }
      return;
    }
    try {
      if (!audioRecordMode.current) {
        await queueAudioMode({ allowsRecordingIOS: true, playsInSilentModeIOS: true, staysActiveInBackground: false, interruptionModeIOS: InterruptionModeIOS.DoNotMix, shouldDuckAndroid: false, interruptionModeAndroid: InterruptionModeAndroid.DoNotMix, playThroughEarpieceAndroid: monitorRoute === "earpiece" });
        audioRecordMode.current = true;
      }
      const result = await cameraRef.current?.recordAsync({ maxDuration: 300, codec: Platform.OS === "ios" ? "hvc1" : undefined });
      const elapsed = stopAndMeasure(); recordingActive.current = false;
      if (result?.uri && elapsed > 0) { const analysis = await analyzeAudio(result.uri).catch(() => undefined); onRecordingComplete(result.uri, elapsed, analysis); }
      else { disarmRecording(); Alert.alert("Recording Error", "Too short."); }
    } catch (e) { stopAndMeasure(); recordingActive.current = false; disarmRecording(); if (!stopFlag.current) Alert.alert("Recording Error", e instanceof Error ? e.message : "Failed."); stopFlag.current = false; }
  }, [startRecording, stopAndMeasure, onRecordingComplete, disarmRecording, queueAudioMode, monitorRoute]);

  useEffect(() => {
    return () => { if (recordingActive.current) { if (Platform.OS === "web") { webRecorderRef.current?.dispose(); webRecorderRef.current = null; } else { Promise.resolve(cameraRef.current?.stopRecording()).catch(() => {}); } stopAndMeasure(); recordingActive.current = false; disarmRecording(); } };
  }, [stopAndMeasure, disarmRecording]);

  const handleStartRecording = async () => {
    if (phase === "armed") return;
    if (!cameraPermission?.granted) { await requestCameraPermission(); return; }
    if (Platform.OS !== "web" && !micPermission?.granted) { await requestMicPermission(); return; }
    if (loops.length >= maxLoops) { Alert.alert("Max Loops", `Up to ${maxLoops} layers.`); return; }
    if (masterDuration) armForNextTake(); else await beginRecording();
  };

  const armForNextTake = useCallback(() => { if (!armRecording()) return; armTriggeredRef.current = false; Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); }, [armRecording]);

  const handleRecordPress = async () => {
    if (phase === "recording") { stopFlag.current = true; if (Platform.OS === "web") webRecorderRef.current?.stop(); else { try { await cameraRef.current?.stopRecording(); } catch {} } }
    else if (phase === "armed") { disarmRecording(); Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error); }
    else await handleStartRecording();
  };

  const handleArmTrigger = useCallback(async () => { if (phaseRef.current !== "armed") return; Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); await beginRecording(); }, [beginRecording]);

  const handleConfirmLoop = useCallback((start: number, end: number, gridBeats: number | null) => {
    if (gridBeats && (BEATS_OPTIONS as readonly number[]).includes(gridBeats)) lockBeatsPerLoop(gridBeats as (typeof BEATS_OPTIONS)[number]);
    confirmLoop(start, end);
  }, [confirmLoop, lockBeatsPerLoop]);

  const handleBrowserConfirm = useCallback((ms: number) => { confirmBracket(ms); }, [confirmBracket]);

  const isRecording = phase === "recording";
  const isArmed = phase === "armed";
  const isTrimming = phase === "trimming";
  const isBrowsing = phase === "browsing";
  const isFinalized = phase === "finalized";
  const isPlaying = phase === "playing";

  useEffect(() => {
    if (!isArmed || !masterDuration) { setArmRemainingFrac(0); return; }
    armTriggeredRef.current = false;
    const startPos = getPlaybackPosition() ?? 0;
    setArmRemainingFrac(Math.max(0, Math.min(1, 1 - startPos / masterDuration)));
    return subscribePlayback((pos) => {
      const remainingMs = masterDuration - pos;
      setArmRemainingFrac(Math.max(0, Math.min(1, remainingMs / masterDuration)));
      if (!armTriggeredRef.current && remainingMs <= ARM_TRIGGER_LEAD_MS) { armTriggeredRef.current = true; handleArmTrigger(); }
    });
  }, [isArmed, masterDuration, subscribePlayback, getPlaybackPosition, handleArmTrigger]);

  const loopsPlaying = isRecording || isArmed || isBrowsing ? true : isGlobalPlaying && (isPlaying || isFinalized);
  const showCamera = isRecording || isArmed || loops.length === 0;
  const showStack = loops.length > 0;
  const canRecord = loops.length < maxLoops && !isTrimming && !isBrowsing && !isFinalized && !isArmed;

  useEffect(() => { if (!showCamera) cameraReady.current = false; }, [showCamera]);
  useEffect(() => { if (!isBrowsing) setBrowseExpanded(false); }, [isBrowsing]);

  useEffect(() => {
    if (!isRecording) { beatIdxRef.current = -1; return; }
    if (!masterDuration) return;
    return subscribePlayback((pos) => {
      const beatMs = masterDuration / beatsPerLoop;
      const idx = Math.floor(pos / beatMs);
      if (idx === beatIdxRef.current) return;
      beatIdxRef.current = idx;
      if (idx % beatsPerLoop === 0) { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); if (!reducedMotion) setBeatFlashKey((k) => k + 1); }
    });
  }, [isRecording, masterDuration, beatsPerLoop, subscribePlayback, reducedMotion]);

  const tapLayerActive = (isPlaying || isArmed || isRecording || isBrowsing) && !isFinalized;
  const handleTapCapture = () => { if (phase === "playing" && loops.length >= maxLoops) return; handleRecordPress(); };

  const topPad = Platform.OS === "web" ? 67 : insets.top;
  const bottomPad = Platform.OS === "web" ? 34 : insets.bottom;
  const { width: screenW, height: screenH } = useWindowDimensions();
  const stageW = screenW - 24 - 128 - 20;
  const stageH = screenH - (topPad + 56) - (bottomPad + 204);
  const frameBottomMargin = Math.max(0, (stageH - stageW) / 2);

  if (!cameraPermission) return <View style={[perm.box, { backgroundColor: VOID_BG }]}><Text style={[perm.text, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)" }]}>checking permissions…</Text></View>;
  if (!cameraPermission.granted) return (
    <View style={[perm.box, { backgroundColor: VOID_BG, paddingTop: topPad + 16 }]}>
      <Ionicons name="camera-outline" size={40} color="rgba(255,255,255,0.5)" />
      <Text style={[perm.title, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)", letterSpacing: tracking.wide }]}>CAMERA ACCESS</Text>
      <Text style={[perm.body, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>camera and microphone access needed</Text>
      <TouchableOpacity style={[perm.btn, { backgroundColor: "#a78bfa" }]} accessibilityRole="button" onPress={async () => { await requestCameraPermission(); await requestMicPermission(); }}>
        <Text style={[perm.btnTxt, { fontFamily: font.thin, color: "#060d06" }]}>grant access</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.root}>
      <StatusBar barStyle="light-content" />

      {showStack && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 2 }, (isRecording || isArmed) && { opacity: 0 }]}>
          <VideoStack loops={loops} isPlaying={loopsPlaying} masterDuration={masterDuration} volume={monitorVolume} soloedId={soloedId} />
        </View>
      )}

      {showStack && !isRecording && !isArmed && <View style={[StyleSheet.absoluteFill, { backgroundColor: "rgba(0,0,0,0.1)", zIndex: 3 }]} />}

      {showCamera && (
        <View style={[styles.cameraStage, { zIndex: 10, backgroundColor: VOID_BG, paddingTop: topPad + 56, paddingBottom: bottomPad + 204 }]}>
          <View style={styles.sideRail}>
            <Text style={[styles.railLabel, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)", letterSpacing: tracking.wide }]}>metro</Text>
            <Metronome beatsPerLoop={beatsPerLoop} active={loopsPlaying} prominent={isRecording} />
            <Text style={[styles.railSub, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>{masterDuration ? `${bpm ?? "—"} bpm` : "—"}</Text>
          </View>

          <View {...(Platform.OS === "web" ? { dataSet: { role: "camera-preview" } } : {})} style={[styles.cameraFrame, { marginBottom: frameBottomMargin }]}>
            <CameraView ref={cameraRef} style={StyleSheet.absoluteFill} facing={facing} mode="video" autofocus="on" ratio={paramRatio ? RATIO_MAP[paramRatio] : undefined}
              onCameraReady={() => { cameraReady.current = true; applyAudioModeRef.current(); }}
              onMountError={(e) => { cameraReady.current = false; disarmRecording(); Alert.alert("Camera Error", e.message || "Camera failed to start. Check that no other app is using the camera and that permissions are granted."); }}
            />
            {!isRecording && !isArmed && (
              <View style={StyleSheet.absoluteFill} onTouchEnd={(e) => { const { locationX, locationY } = e.nativeEvent; triggerFocusIndicator(locationX, locationY); }} pointerEvents="auto" importantForAccessibility="no-hide-descendants" />
            )}
            {focusPoint && !isRecording && (
              <Animated.View style={[focusAnimStyle, { position: "absolute", left: focusPoint.x - 44, top: focusPoint.y - 44, width: 88, height: 88, borderRadius: 44, borderWidth: 1.5, borderColor: "#a78bfa", pointerEvents: "none" }]} />
            )}
          </View>

          <View style={styles.sideRail}>
            <Text style={[styles.railLabel, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)", letterSpacing: tracking.wide }]}>monitor</Text>
            <TouchableOpacity
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setMonitorSheetOpen(true); }}
              onLongPress={() => { setMonitorOn(!monitorOn); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); }}
              style={[styles.railBtn, { borderColor: monitorOn ? "#a78bfa" : "rgba(255,255,255,0.06)", backgroundColor: monitorOn ? "rgba(167,139,250,0.08)" : "rgba(255,255,255,0.035)" }]}
              accessibilityRole="button" accessibilityLabel="Monitor device settings"
            >
              <Ionicons name={monitorOn ? "headset" : "headset-outline"} size={18} color={monitorOn ? "#a78bfa" : "rgba(255,255,255,0.5)"} />
            </TouchableOpacity>
            <VerticalFader value={monitorVolume} onChange={setMonitorVolumePersist} height={160} />
            <Text style={[styles.railSub, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>{Math.round(monitorVolume * 100)}%</Text>
          </View>
        </View>
      )}

      {isArmed && masterDuration && (
        <View style={[StyleSheet.absoluteFill, { zIndex: 19, borderWidth: 1.5, borderColor: "#a78bfa", margin: 48, borderRadius: 12 }]} pointerEvents="none" />
      )}

      {tapLayerActive && <Pressable style={[StyleSheet.absoluteFill, { zIndex: 20 }]} onPress={handleTapCapture} accessibilityRole="button" accessibilityLabel={isBrowsing ? "Keep take" : isArmed ? "Cancel" : isRecording ? "Stop" : "Record"} />}

      {/* TOP BAR */}
      <View style={[styles.topBar, { paddingTop: topPad + 8, zIndex: 25 }]}>
        <View style={styles.topSide}>
          <TouchableOpacity onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); router.back(); }} accessibilityRole="button" accessibilityLabel="Go back" hitSlop={8} style={[gS.btn, { backgroundColor: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.06)" }]}>
            <Ionicons name="chevron-back" size={16} color="rgba(255,255,255,0.6)" />
          </TouchableOpacity>
          {loops.length > 0 && (
            <View style={styles.savedRow}>
              <Text style={[styles.layerCount, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>{loops.length}/{maxLoops}</Text>
              <View style={[styles.savedDot, { backgroundColor: "#a78bfa" }]} />
            </View>
          )}
        </View>

        <View style={styles.topCenter}>
          {!isRecording && !isArmed && loops.length === 0 && <Text style={[styles.wordmark, { fontFamily: font.thin, color: "rgba(255,255,255,0.7)" }]}>AESTHETIC</Text>}
          {isRecording && <Text style={[styles.timer, { fontFamily: font.mono, color: "rgba(255,255,255,0.92)", fontSize: masterDuration ? 13 : 18 }]}>{masterDuration ? loopPositionLabel(recordingDuration, masterDuration, beatsPerLoop) : formatDuration(recordingDuration)}</Text>}
          {isArmed && <Text style={[styles.armedLabel, { fontFamily: font.thin, color: "#a78bfa" }]}>ARMED · WAITING</Text>}
          {!isRecording && !isArmed && isFinalized && <Text style={[styles.tag, { fontFamily: font.thin, color: "#a78bfa" }]}>FINALIZED</Text>}
        </View>

        <View style={styles.topRight}>
          {loops.length > 0 && masterDuration && (
            <View style={styles.bpmBox}>
              <Text style={[styles.bpmVal, { fontFamily: font.mono, color: "#a78bfa" }]}>{bpm ?? "—"}</Text>
              <Text style={[styles.bpmLabel, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>BPM</Text>
            </View>
          )}
          {loops.length > 0 && <GlassBtn name="share-outline" color="rgba(255,255,255,0.6)" label="Export" onPress={() => { setShowExport(true); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }} />}
          {!isRecording && !isArmed && loops.length > 0 && <GlassBtn name="trash-outline" color="rgba(255,255,255,0.35)" label="Clear" onPress={() => { const c = (done: () => void) => { if (Platform.OS === "web") { if (globalThis.confirm?.("Remove all loops?")) done(); } else Alert.alert("Clear Project", "Remove all loops?", [{ text: "Cancel", style: "cancel" }, { text: "Clear", style: "destructive", onPress: done }]); }; c(clearAll); }} />}
          {!isRecording && !isArmed && loops.length === 0 && <GlassBtn name="camera-reverse-outline" color="rgba(255,255,255,0.6)" label="Flip" onPress={() => { setFacing(f => f === "back" ? "front" : "back"); Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); }} />}
        </View>
      </View>

      {/* BOTTOM CARD — glass */}
      <View style={[styles.card, { paddingBottom: bottomPad + 16, zIndex: 22 }]}>
        {isNative && <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />}
        <LinearGradient colors={["rgba(255,255,255,0.05)", "rgba(255,255,255,0.02)"]} start={{ x: 0.5, y: 0 }} end={{ x: 0.5, y: 1 }} style={StyleSheet.absoluteFill} pointerEvents="none" />
        <View style={[styles.handle, { backgroundColor: "rgba(255,255,255,0.08)" }]} />

        {loops.length > 0 && !isTrimming && !isBrowsing && (
          <StackedTimeline loops={loops} masterDuration={masterDuration} beatsPerLoop={beatsPerLoop} soloedId={soloedId}
            onEditLoop={(id) => { setShowExport(false); startEditLoop(id); }}
            onToggleMute={(id) => { const l = loops.find(l => l.id === id); if (l) updateLoopTrack(id, { muted: !l.muted }); }}
            onToggleSolo={(id) => setSoloedId(soloedId === id ? null : id)}
            onRemoveLoop={isFinalized ? () => {} : removeLoop}
          />
        )}

        {isBrowsing && pendingLoop && masterDuration !== null && <EnvelopeDock onExpand={() => setBrowseExpanded(true)} auditionActive={!browseExpanded} onKeep={() => handleBrowserConfirm(pendingBracketMs)} />}

        <View style={styles.controlRow}>
          <View style={styles.sideCell}>
            {!showCamera && loops.length > 0 && (
              <View style={styles.leftCluster}>
                <MonitorCompact monitorOn={monitorOn} route={monitorRoute} onToggle={() => setMonitorOn(!monitorOn)} onOpenSettings={() => setMonitorSheetOpen(true)} />
                <Metronome beatsPerLoop={beatsPerLoop} active={loopsPlaying} prominent={isRecording} />
              </View>
            )}
          </View>

          {!isFinalized ? (
            <View style={styles.recordWrap}>
              <RecordButton isRecording={isRecording} isArmed={isArmed} beatFlashKey={beatFlashKey} onPress={handleRecordPress} disabled={!canRecord && !isRecording && !isArmed} />
              {isArmed && <ArmRing remainingFrac={armRemainingFrac} beats={beatsPerLoop} />}
            </View>
          ) : (
            <View style={[styles.finalIcon, { borderColor: "#a78bfa" }]}><Ionicons name="musical-notes" size={24} color="#a78bfa" /></View>
          )}

          <View style={styles.sideCell}>
            {!isRecording && !isArmed && loops.length > 0 && (
              <TouchableOpacity onPress={toggleGlobalPlayback} style={[styles.iconBtn, { backgroundColor: "rgba(255,255,255,0.035)", borderColor: "rgba(255,255,255,0.06)" }]} accessibilityRole="button" accessibilityLabel={isGlobalPlaying ? "Stop" : "Play"}>
                <Ionicons name={isGlobalPlaying ? "stop" : "play"} size={16} color="rgba(255,255,255,0.92)" />
              </TouchableOpacity>
            )}
          </View>
        </View>

        {!isTrimming && !isBrowsing && !isArmed && !isRecording && loops.length > 0 && (
          <TouchableOpacity
            onPress={() => { if (isFinalized) return; if (loops.length >= maxLoops) { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); finalizeProject(); } else armForNextTake(); }}
            style={[styles.saveBtn, { backgroundColor: isFinalized ? "transparent" : "#a78bfa", borderColor: "rgba(167,139,250,0.3)" }]}
            accessibilityRole="button" accessibilityLabel={loops.length >= maxLoops ? "Save" : "Next layer"}
          >
            <Ionicons name={isFinalized ? "checkmark" : loops.length >= maxLoops ? "save-outline" : "arrow-forward"} size={14} color={isFinalized ? "#a78bfa" : "#060d06"} />
            <Text style={[styles.saveTxt, { fontFamily: font.thin, color: isFinalized ? "#a78bfa" : "#060d06" }]}>
              {isFinalized ? "saved · auto-stored" : loops.length >= maxLoops ? "save" : "next layer"}
            </Text>
          </TouchableOpacity>
        )}

        <Text style={[styles.hint, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>
          {isRecording && loops.length === 0 && "recording freely — trim to set the master tempo"}
          {isRecording && loops.length > 0 && "recording — tap anywhere to stop"}
          {isArmed && "armed — recording begins as the loop closes"}
          {isBrowsing && "your take is in the loop — nudge the envelope, or keep going"}
          {!isRecording && !isArmed && loops.length === 0 && "tap record to begin"}
          {!isRecording && !isArmed && !isBrowsing && !isFinalized && loops.length > 0 && loops.length < maxLoops && `${maxLoops - loops.length} layer${maxLoops - loops.length !== 1 ? "s" : ""} remaining`}
          {!isRecording && !isArmed && !isBrowsing && !isFinalized && loops.length >= maxLoops && "all layers recorded · tap a track to re-trim"}
          {isFinalized && "composition saved · tap a track to re-trim"}
        </Text>
      </View>

      {/* MODALS */}
      <Modal visible={isTrimming && !!pendingLoop} animationType="slide" presentationStyle="pageSheet" onRequestClose={discardPending}>
        <View style={[styles.sheet, { backgroundColor: VOID_BG }]}>
          <SheetHeader title="SET LOOP LENGTH" subtitle="This length becomes the master tempo" onClose={discardPending} />
          {pendingLoop && <TrimEditor uri={pendingLoop.uri} duration={pendingLoop.duration} waveformData={pendingLoop.waveformData} detectedBpm={pendingLoop.detectedBpm} onConfirm={handleConfirmLoop} onDiscard={discardPending} />}
        </View>
      </Modal>

      <Modal visible={browseExpanded && isBrowsing && !!pendingLoop} animationType="slide" presentationStyle="pageSheet" onRequestClose={() => setBrowseExpanded(false)}>
        <View style={[styles.sheet, { backgroundColor: VOID_BG }]}>
          <SheetHeader title="CHOOSE YOUR SECTION" subtitle={`Layer ${loops.length + 1} of ${maxLoops}`} onClose={() => setBrowseExpanded(false)} />
          {pendingLoop && masterDuration !== null && (
            <TimelineBrowser uri={pendingLoop.uri} duration={pendingLoop.duration} masterDuration={masterDuration} waveformData={pendingLoop.waveformData} loopNumber={loops.length + 1} bracketStartMs={pendingBracketMs} onBracketChange={setPendingBracket} beatsPerLoop={beatsPerLoop} syncWithClock confirmLabel="record next loop" onConfirm={(ms) => handleBrowserConfirm(ms)} onDiscard={discardPending} />
          )}
        </View>
      </Modal>

      <Modal visible={!!editingLoop} animationType="slide" presentationStyle="pageSheet" onRequestClose={cancelEditLoop}>
        <View style={[styles.sheet, { backgroundColor: VOID_BG }]}>
          <SheetHeader title={`RE-EDIT LAYER ${editingLoop ? editingLoop.layerIndex + 1 : ""}`} subtitle="Slide the bracket to a new section" onClose={cancelEditLoop} />
          {editingLoop && masterDuration !== null && (
            <TimelineBrowser uri={editingLoop.fullRecordingUri || editingLoop.videoUri} duration={editingLoop.fullRecordingDuration || editingLoop.duration} masterDuration={masterDuration} waveformData={editingLoop.waveformData} loopNumber={editingLoop.layerIndex + 1} initialBracketStartMs={editingLoop.bracketStartMs} beatsPerLoop={beatsPerLoop} confirmLabel="Save Changes" volume={editingLoop.volume} onVolumeChange={(v) => updateLoopTrack(editingLoop.id, { volume: v })} onConfirm={(ms) => confirmEditBracket(editingLoop.id, ms)} onDiscard={cancelEditLoop} />
          )}
        </View>
      </Modal>

      <ExportPanel visible={showExport} loops={loops} onClose={() => setShowExport(false)} />
      <MonitorSheet visible={monitorSheetOpen} onClose={() => setMonitorSheetOpen(false)} monitorOn={monitorOn} onMonitorToggle={() => setMonitorOn(!monitorOn)} volume={monitorVolume} onVolumeChange={setMonitorVolumePersist} route={monitorRoute} onRouteChange={setMonitorRoutePersist} isRecording={isRecording} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: VOID_BG },
  cameraStage: { ...StyleSheet.absoluteFillObject, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 10, paddingHorizontal: 12 },
  sideRail: { width: 64, alignItems: "center", justifyContent: "center", gap: 14 },
  railLabel: { fontSize: 9, letterSpacing: 2 },
  railSub: { fontSize: 11, letterSpacing: 0.5 },
  railBtn: { width: 42, height: 42, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  cameraFrame: { flex: 1, alignSelf: "stretch", overflow: "hidden", borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, borderColor: "rgba(255,255,255,0.06)" },
  recordWrap: { width: 80, height: 80, alignItems: "center", justifyContent: "center" },
  topBar: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "flex-start", paddingHorizontal: 12, paddingBottom: 10 },
  topSide: { flex: 1, flexDirection: "row", alignItems: "flex-start", gap: 10 },
  topCenter: { flex: 2, alignItems: "center" },
  topRight: { flex: 1, flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 8 },
  wordmark: { fontSize: 12, letterSpacing: 6 },
  timer: { fontSize: 18 },
  armedLabel: { fontSize: 11, letterSpacing: 3 },
  tag: { fontSize: 10, letterSpacing: 2 },
  savedRow: { flexDirection: "row", alignItems: "center", gap: 5, paddingTop: 8 },
  savedDot: { width: 4, height: 4, borderRadius: 2 },
  layerCount: { fontSize: 13, letterSpacing: 1 },
  bpmBox: { alignItems: "center", paddingTop: 2 },
  bpmVal: { fontSize: 14, lineHeight: 16 },
  bpmLabel: { fontSize: 8, letterSpacing: 1.5 },
  card: {
    position: "absolute", bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingTop: 8, gap: 10,
    backgroundColor: "rgba(255,255,255,0.035)",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
    shadowColor: "#000", shadowOffset: { width: 0, height: -8 }, shadowOpacity: 0.3, shadowRadius: 32,
  },
  handle: { width: 32, height: 3, borderRadius: 2, alignSelf: "center" },
  controlRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", paddingHorizontal: 32 },
  sideCell: { flex: 1, alignItems: "center" },
  leftCluster: { flexDirection: "row", alignItems: "center", gap: 14 },
  iconBtn: { width: 40, height: 40, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: "center", justifyContent: "center" },
  finalIcon: { width: 68, height: 68, borderRadius: 20, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  saveBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 12, borderRadius: 16, borderWidth: 1, marginHorizontal: 32,
    shadowColor: "#a78bfa", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 16,
  },
  saveTxt: { fontSize: 13, letterSpacing: 2 },
  hint: { textAlign: "center", fontSize: 11, letterSpacing: 0.3, paddingHorizontal: 24 },
  sheet: { flex: 1 },
});

const perm = StyleSheet.create({
  box: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18, padding: 36 },
  title: { fontSize: 13, textAlign: "center" },
  body: { fontSize: 14, textAlign: "center", lineHeight: 21 },
  text: { fontSize: 15, textAlign: "center" },
  btn: { paddingHorizontal: 36, paddingVertical: 15, borderRadius: 16, marginTop: 8 },
  btnTxt: { fontSize: 15 },
});
