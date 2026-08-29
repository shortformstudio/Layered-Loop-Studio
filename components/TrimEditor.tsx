import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { AVPlaybackStatus, ResizeMode, Video } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";
import WaveformBars from "@/components/WaveformBars";

const PAD = 24;
const HANDLE_W = 20;
const MIN_LOOP_MS = 250;
const BEATS_OPTIONS = [2, 4, 8, 16] as const;

interface TrimEditorProps {
  uri: string;
  duration: number;
  waveformData: number[];
  /** Tempo detected from the recording (web); null when unknown */
  detectedBpm?: number | null;
  onConfirm: (startTrim: number, endTrim: number, gridBeats: number | null) => void;
  onDiscard: () => void;
}

/** Coarse, uncluttered time readout — integer seconds. */
function formatTime(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

/** Snap a beat count to the nearest supported grid (2/4/8/16), min 2. */
function nearestBeatOption(beats: number): number {
  let best = 2;
  for (const option of BEATS_OPTIONS) {
    if (Math.abs(option - beats) < Math.abs(best - beats)) best = option;
  }
  return best;
}

export default function TrimEditor({
  uri,
  duration,
  waveformData,
  detectedBpm,
  onConfirm,
  onDiscard,
}: TrimEditorProps) {
  const colors = useColors();
  const { width: screenW } = useWindowDimensions();
  const waveW = screenW - PAD * 2;
  const videoRef = useRef<Video>(null);
  // Auto-plays on mount — the take starts looping its frame the moment
  // recording stops; the trim handles reshape it live.
  const [isPlaying, setIsPlaying] = useState(true);
  const [startRatio, setStartRatio] = useState(0);
  const [endRatio, setEndRatio] = useState(1);
  const startRef = useRef(0);
  const endRef = useRef(1);
  const seekingRef = useRef(false);
  const startSnapTick = useRef(false);
  const endSnapTick = useRef(false);

  // Red playhead — sweeps across the waveform wherever the preview plays.
  const playheadX = useSharedValue(0);
  // Wrap seeks on a just-recorded file are expensive when frame-exact —
  // loose tolerance + a cooldown keep the wrap snappy instead of stalling
  // the preview at the loop start.
  const seekCooldownRef = useRef(0);

  // Snap config lives in refs so the PanResponders (created once) never
  // capture stale closures mid-gesture. Snapping follows the detected tempo
  // silently — BPM is a read-only parameter.
  const beatMsRef = useRef<number | null>(detectedBpm ? 60000 / detectedBpm : null);

  const startMs = startRatio * duration;
  const endMs = endRatio * duration;
  const loopLen = endMs - startMs;
  const beatMs = beatMsRef.current;
  const selectionBeats = beatMs ? loopLen / beatMs : null;
  const derivedBpm = loopLen > 0 ? Math.round((60000 / loopLen) * 10) / 10 : null;

  const beatMarkers = useMemo(() => {
    if (!beatMs) return [];
    const markers: number[] = [];
    const count = Math.floor(duration / beatMs);
    for (let k = 1; k <= count; k++) {
      const r = (k * beatMs) / duration;
      if (r < 1) markers.push(r);
    }
    return markers;
  }, [beatMs, duration]);

  const handleStatus = useCallback(async (status: AVPlaybackStatus) => {
    if (!status.isLoaded) return;
    playheadX.value = withTiming(
      (status.positionMillis / Math.max(1, duration)) * waveW,
      { duration: 120 }
    );
    if (seekingRef.current) return;
    if (Date.now() - seekCooldownRef.current < 300) return;
    const startEdge = startRef.current * duration;
    const endEdge = endRef.current * duration;
    // Wrap at the end; recover only when well outside the loop bounds
    // (threshold wider than the seek tolerance so a slightly-short wrap
    // landing can't re-trigger recovery in a loop).
    if (status.positionMillis >= endEdge - 80 || status.positionMillis < startEdge - 300) {
      seekingRef.current = true;
      try {
        await videoRef.current?.setPositionAsync(startEdge, {
          toleranceMillisBefore: 120,
          toleranceMillisAfter: 120,
        });
        playheadX.value = (startEdge / Math.max(1, duration)) * waveW;
        if (!status.isPlaying) {
          await videoRef.current?.playAsync();
        }
        seekCooldownRef.current = Date.now();
      } catch {
        /* seek raced a load/unload — the next status update re-anchors */
      } finally {
        seekingRef.current = false;
      }
    }
  }, [duration, waveW]);

  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: playheadX.value }],
  }));

  const togglePlay = async () => {
    if (!isPlaying) {
      try {
        await videoRef.current?.setPositionAsync(startRatio * duration);
        await videoRef.current?.playAsync();
        setIsPlaying(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } catch {
        setIsPlaying(false);
      }
    } else {
      try {
        await videoRef.current?.pauseAsync();
        setIsPlaying(false);
      } catch {
        /* already paused */
      }
    }
  };

  /** Snap a raw time to the nearest beat when within a quarter-beat magnet zone. */
  const snapMs = useCallback(
    (ms: number): { value: number; snapped: boolean } => {
      const beat = beatMsRef.current;
      if (!beat) return { value: ms, snapped: false };
      const snappedMs = Math.round(ms / beat) * beat;
      const engaged = Math.abs(ms - snappedMs) <= beat * 0.25;
      return { value: engaged ? snappedMs : ms, snapped: engaged };
    },
    []
  );

  const startPan = useMemo(() => {
    // Snapshot the handle position at gesture grant — gs.dx is the TOTAL
    // delta from grant, so it must be added to the grant-time value. Adding
    // it to the live value re-applied every move event, which made the
    // handles rocket to min/max ("too sensitive").
    let grantR = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        grantR = startRef.current;
        Haptics.selectionAsync();
      },
      onPanResponderMove: (_, gs) => {
        const rawMs = (grantR + gs.dx / waveW) * duration;
        const { value, snapped } = snapMs(rawMs);
        if (snapped && !startSnapTick.current) Haptics.selectionAsync();
        startSnapTick.current = snapped;
        const maxR = Math.max(0, (endRef.current * duration - MIN_LOOP_MS) / duration);
        const next = Math.min(maxR, Math.max(0, value / duration));
        startRef.current = next;
        setStartRatio(next);
      },
      onPanResponderRelease: () => {
        startSnapTick.current = false;
        Haptics.selectionAsync();
      },
    });
  }, [duration, snapMs, waveW]);

  const endPan = useMemo(() => {
    let grantR = 1;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: () => {
        grantR = endRef.current;
        Haptics.selectionAsync();
      },
      onPanResponderMove: (_, gs) => {
        const rawMs = (grantR + gs.dx / waveW) * duration;
        const { value, snapped } = snapMs(rawMs);
        if (snapped && !endSnapTick.current) Haptics.selectionAsync();
        endSnapTick.current = snapped;
        const minR = Math.min(1, (startRef.current * duration + MIN_LOOP_MS) / duration);
        const next = Math.min(1, Math.max(minR, value / duration));
        endRef.current = next;
        setEndRatio(next);
      },
      onPanResponderRelease: () => {
        endSnapTick.current = false;
        Haptics.selectionAsync();
      },
    });
  }, [duration, snapMs, waveW]);

  // Keep handles from overlapping on very short loops
  const startPx = startRatio * waveW;
  const endPx = endRatio * waveW;
  const startLeft = Math.min(startPx - HANDLE_W / 2, endPx - HANDLE_W);
  const endLeft = Math.max(endPx - HANDLE_W / 2, startPx);

  const handleConfirm = () => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const gridBeats =
      beatMs && selectionBeats !== null && selectionBeats > 0
        ? nearestBeatOption(Math.round(selectionBeats))
        : null;
    onConfirm(startMs, endMs, gridBeats);
  };

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Video preview */}
      <View style={[styles.video, { height: screenW * 0.52 }]}>
        <Video
          ref={videoRef}
          source={{ uri }}
          style={StyleSheet.absoluteFill}
          resizeMode={ResizeMode.COVER}
          shouldPlay={isPlaying}
          isLooping={false}
          isMuted={false}
          onPlaybackStatusUpdate={handleStatus}
          useNativeControls={false}
          progressUpdateIntervalMillis={100}
        />
        <TouchableOpacity
          onPress={togglePlay}
          style={[styles.playBtn, { backgroundColor: colors.overlay }]}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? "Pause preview" : "Play preview"}
        >
          <Ionicons name={isPlaying ? "pause" : "play"} size={26} color={colors.onDark} />
        </TouchableOpacity>
        <View style={[styles.badge, { backgroundColor: colors.overlay }]}>
          <Text style={[styles.badgeText, { fontFamily: font.thin, color: colors.primary }]}>
            {formatTime(loopLen)}
          </Text>
        </View>
      </View>

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* Waveform + handles */}
        <View style={styles.section}>
          <Text style={[styles.sectionLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>
            TRIM LOOP · DRAG HANDLES
          </Text>

          <View style={{ position: "relative" }}>
            <WaveformBars
              data={waveformData}
              width={waveW}
              height={68}
              startRatio={startRatio}
              endRatio={endRatio}
              activeColor={colors.primary}
              inactiveColor={colors.waveInactive}
              beatMarkers={beatMarkers}
              markerColor={`${colors.foreground}26`}
            />
            {/* Red playhead — follows the preview position */}
            <Animated.View
              pointerEvents="none"
              style={[styles.playhead, playheadStyle]}
            />
            {/* Start handle */}
            <View
              {...startPan.panHandlers}
              style={[styles.handle, { left: startLeft, backgroundColor: colors.primary }]}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel="Trim start"
              accessibilityValue={{ min: 0, max: duration, now: Math.round(startMs) }}
            >
              <Ionicons name="chevron-forward" size={11} color={colors.primaryForeground} />
            </View>
            {/* End handle */}
            <View
              {...endPan.panHandlers}
              style={[styles.handle, { left: endLeft, backgroundColor: colors.primary }]}
              accessible
              accessibilityRole="adjustable"
              accessibilityLabel="Trim end"
              accessibilityValue={{ min: 0, max: duration, now: Math.round(endMs) }}
            >
              <Ionicons name="chevron-back" size={11} color={colors.primaryForeground} />
            </View>
          </View>

          {/* Read-only tempo readout */}
          <View style={[styles.timeRow, { backgroundColor: colors.cardAlt }]}>
            <View style={styles.timeCell}>
              <Text style={[styles.timeLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>BPM</Text>
              <Text style={[styles.timeVal, { fontFamily: font.mono, color: derivedBpm ? colors.primary : colors.mutedForeground }]}>
                {derivedBpm ?? "—"}
              </Text>
            </View>
            <View style={[styles.timeDivider, { backgroundColor: colors.border }]} />
            <View style={styles.timeCell}>
              <Text style={[styles.timeLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>TIME</Text>
              <Text style={[styles.timeVal, { fontFamily: font.mono, color: colors.foreground }]}>{formatTime(loopLen)}</Text>
            </View>
          </View>
        </View>

        <Text style={[styles.tip, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          This length sets the master tempo for every layer
        </Text>

        {/* Actions — the sheet header ✕ discards; confirm sets the loop */}
        <View style={styles.actions}>
          <TouchableOpacity
            onPress={handleConfirm}
            style={[styles.btnPri, { backgroundColor: colors.primary }]}
            accessibilityRole="button"
            accessibilityLabel="Confirm loop length"
          >
            <Text style={[styles.btnPriTxt, { fontFamily: font.thin, color: colors.primaryForeground }]}>record next loop</Text>
          </TouchableOpacity>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },
  video: { width: "100%", backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  playBtn: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center" },
  badge: {
    position: "absolute", bottom: 12, right: 12,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16,
  },
  badgeText: { fontSize: 13 },
  section: { paddingHorizontal: PAD, paddingTop: 24, gap: 14 },
  sectionLabel: { fontSize: 10 },
  handle: {
    position: "absolute", top: 0, bottom: 0,
    width: HANDLE_W, borderRadius: 5,
    alignItems: "center", justifyContent: "center", zIndex: 10,
  },
  playhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: "#E2483D",
    zIndex: 5,
  },
  timeRow: { flexDirection: "row", borderRadius: 12, overflow: "hidden" },
  timeCell: { flex: 1, paddingVertical: 12, alignItems: "center", gap: 4 },
  timeLabel: { fontSize: 9 },
  timeVal: { fontSize: 16 },
  timeDivider: { width: StyleSheet.hairlineWidth, marginVertical: 8 },
  tip: { textAlign: "center", fontSize: 12, paddingHorizontal: PAD, marginTop: 8 },
  actions: { flexDirection: "row", gap: 10, paddingHorizontal: PAD, paddingTop: 20 },
  btnPri: {
    flex: 1, paddingVertical: 16, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  btnPriTxt: { fontSize: 15 },
});
