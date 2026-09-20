import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Dimensions,
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { createVideoPlayer, VideoView } from "expo-video";
import type { VideoPlayer } from "expo-video";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { useClockSyncedPreview } from "@/hooks/useClockSyncedPreview";
import { useConfirmOnce } from "@/hooks/useConfirmOnce";
import { font, tracking } from "@/constants/typography";
import WaveformBars from "@/components/WaveformBars";

const { width: SCREEN_W } = Dimensions.get("window");
const PAD = 24;
const WAVEFORM_W = SCREEN_W - PAD * 2;

/** Coarse, uncluttered readout — integer seconds. */
function formatTime(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

interface TimelineBrowserProps {
  uri: string;
  duration: number;
  masterDuration: number;
  waveformData: number[];
  loopNumber: number;
  initialBracketStartMs?: number;
  confirmLabel?: string;
  /** Beats per master loop — drives the fine snap grid */
  beatsPerLoop?: number;
  /** Current layer volume (re-edit); undefined for a fresh layer */
  volume?: number;
  /** Live volume edits while in the choose-section phase */
  onVolumeChange?: (v: number) => void;
  /** True for fresh takes: preview locks to the master clock and all layers
   *  keep playing on loop while the bracket is chosen. False (re-edit) keeps
   *  the standalone play/pause audition. */
  syncWithClock?: boolean;
  /** Controlled envelope position (ms). When provided, movement is driven
   *  by onBracketChange instead of internal state (shared with EnvelopeDock). */
  bracketStartMs?: number;
  onBracketChange?: (ms: number) => void;
  onConfirm: (bracketStartMs: number, volume: number) => void;
  onDiscard: () => void;
}

export default function TimelineBrowser({
  uri,
  duration,
  masterDuration,
  waveformData,
  loopNumber,
  initialBracketStartMs = 0,
  confirmLabel,
  beatsPerLoop = 4,
  volume: volumeProp,
  onVolumeChange,
  syncWithClock = false,
  bracketStartMs: bracketStartMsProp,
  onBracketChange,
  onConfirm,
  onDiscard,
}: TimelineBrowserProps) {
  const colors = useColors();
  const playerRef = useRef<VideoPlayer | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [videoError, setVideoError] = useState(false);

  // Guard against zero-length takes: all ratio math stays finite.
  const safeDuration = Math.max(duration, 1);
  /** A take that cannot fill the master loop — block confirm, say why. */
  const takeInvalid = duration <= 0 || duration < masterDuration;

  const controlled = bracketStartMsProp !== undefined;
  const initPos = Math.min(
    (controlled ? bracketStartMsProp! : initialBracketStartMs) / safeDuration,
    Math.max(0, 1 - masterDuration / safeDuration)
  );
  const [internalPos, setInternalPos] = useState(initPos);
  const bracketPos = controlled ? bracketStartMsProp! / safeDuration : internalPos;
  const bracketPosRef = useRef(bracketPos);
  bracketPosRef.current = bracketPos;
  const bracketMsRef = useRef(bracketPos * safeDuration);
  bracketMsRef.current = bracketPos * safeDuration;
  const startPosRef = useRef(bracketPos);
  const seekingRef = useRef(false);
  const bracketRatio = Math.min(1, masterDuration / safeDuration);
  // Clamp beatsPerLoop ≥ 2 to prevent Infinity from division by zero. (G30)
  const safeBeatsPerLoop = Math.max(2, Math.round(beatsPerLoop));
  const beatUnitMs = masterDuration / safeBeatsPerLoop;
  const maxBracketMs = Math.max(0, safeDuration - masterDuration);

  // Fully controlled volume — parent changes propagate live. (G29 fix.)
  const [volume, setVolume] = useState(volumeProp ?? 1);
  useEffect(() => {
    if (volumeProp !== undefined) setVolume(volumeProp);
  }, [volumeProp]);

  const bracketStartMs = bracketPos * safeDuration;
  const bracketEndMs = bracketStartMs + masterDuration;
  const beatIndex = Math.round(bracketStartMs / beatUnitMs);
  const maxSections = Math.max(1, Math.floor(maxBracketMs / beatUnitMs) + 1);
  const sectionIndex = Math.min(maxSections, beatIndex + 1);
  const canLeft = bracketStartMs > beatUnitMs / 2;
  const canRight = bracketStartMs < maxBracketMs - beatUnitMs / 2;

  // ── Clock-synced audition (fresh takes) ──────────────────────────────
  const { videoPosRef, jumpTo } = useClockSyncedPreview(
    playerRef,
    bracketMsRef,
    syncWithClock,
    masterDuration
  );

  // Red playhead — follows the preview position across the full recording.
  const playheadX = useSharedValue(0);
  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: playheadX.value }],
  }));

  useEffect(() => {
    const p = createVideoPlayer({ uri });
    p.loop = false;
    p.muted = false;
    p.volume = volume;
    p.timeUpdateEventInterval = 0.05;
    const pc = p as unknown as {
      addListener: (
        ev: string,
        cb: (data: { isPlaying?: boolean; currentTime?: number }) => void,
      ) => { remove: () => void };
    };
    const subs: { remove: () => void }[] = [];
    subs.push(
      pc.addListener("playingChange", (d) => {
        if (typeof d.isPlaying === "boolean") setIsPlaying(d.isPlaying);
      }),
    );
    subs.push(
      pc.addListener("timeUpdate", (d) => {
        const curSec = d.currentTime ?? 0;
        const curMs = curSec * 1000;
        videoPosRef.current = curMs;
        playheadX.value = (curMs / Math.max(1, safeDuration)) * WAVEFORM_W;

        if (syncWithClock || seekingRef.current) return;
        const endMs = (bracketPosRef.current + bracketRatio) * safeDuration;
        if (curMs >= endMs - 80 || curMs < bracketPosRef.current * safeDuration - 80) {
          seekingRef.current = true;
          p.currentTime = (bracketPosRef.current * safeDuration) / 1000;
          if (!p.playing) p.play();
          seekingRef.current = false;
        }
      }),
    );
    playerRef.current = p;
    setIsReady(true);
    if (syncWithClock) {
      p.play();
    }
    return () => {
      subs.forEach((s) => {
        try { s.remove(); } catch {}
      });
      try { p.pause(); p.release(); } catch {}
      playerRef.current = null;
    };
  }, [uri, syncWithClock, safeDuration, bracketRatio]);

  useEffect(() => {
    if (playerRef.current) {
      playerRef.current.volume = volume;
    }
  }, [volume]);

  // ── Bracket movement: drag (snap on release) + beat-step arrows ──────
  const applyBracket = useCallback((ms: number) => {
    const clamped = Math.max(0, Math.min(maxBracketMs, ms));
    bracketPosRef.current = clamped / safeDuration;
    bracketMsRef.current = clamped;
    if (controlled) {
      onBracketChange?.(clamped);
    } else {
      setInternalPos(clamped / safeDuration);
    }
  }, [controlled, maxBracketMs, safeDuration, onBracketChange]);

  /** Step the envelope by exactly one beat — arrows left/right. */
  const stepBracket = useCallback((dir: -1 | 1) => {
    const k = Math.round(bracketMsRef.current / beatUnitMs) + dir;
    const nextMs = Math.max(0, Math.min(maxBracketMs, k * beatUnitMs));
    applyBracket(nextMs);
    if (syncWithClock) jumpTo(nextMs);
    Haptics.selectionAsync();
  }, [beatUnitMs, maxBracketMs, syncWithClock, applyBracket, jumpTo]);

  const togglePlay = async () => {
    const p = playerRef.current;
    if (!p) return;
    try {
      if (!isPlaying) {
        p.currentTime = bracketMsRef.current / 1000;
        p.play();
        setIsPlaying(true);
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      } else {
        p.pause();
        setIsPlaying(false);
      }
    } catch {
      setIsPlaying(false);
    }
  };

  // ── Hardened envelope gestures ──────────────────────────────────────────
  // The PanResponders below are created ONCE. Everything they need flows
  // through refs, so bracket/volume state changes mid-drag never recreate
  // the responder (recreation = dropped gestures = envelope jitter).

  const applyBracketRef = useRef(applyBracket);
  applyBracketRef.current = applyBracket;
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;
  const syncRef = useRef(syncWithClock);
  syncRef.current = syncWithClock;
  const safeDurationRef = useRef(safeDuration);
  safeDurationRef.current = safeDuration;
  const bracketRatioRef = useRef(bracketRatio);
  bracketRatioRef.current = bracketRatio;
  const beatsRef = useRef(safeBeatsPerLoop);
  beatsRef.current = safeBeatsPerLoop;

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          startPosRef.current = bracketPosRef.current;
          Haptics.selectionAsync();
        },
        onPanResponderMove: (_, gs) => {
          const maxPos = 1 - bracketRatioRef.current;
          const next = Math.max(
            0,
            Math.min(maxPos, startPosRef.current + gs.dx / WAVEFORM_W)
          );
          const nextMs = next * safeDurationRef.current;
          applyBracketRef.current(nextMs);
          if (syncRef.current) jumpToRef.current(nextMs);
        },
        onPanResponderRelease: () => {
          // Snap to nearest master beat — bracket starts can sit on any beat,
          // not just whole-loop boundaries, for offset layer starts.
          const rawPos = bracketPosRef.current;
          const beatUnit = bracketRatioRef.current / beatsRef.current;
          const snappedPos = Math.round(rawPos / beatUnit) * beatUnit;
          const maxPos = 1 - bracketRatioRef.current;
          const clamped = Math.max(0, Math.min(maxPos, snappedPos));
          const snappedMs = clamped * safeDurationRef.current;
          applyBracketRef.current(snappedMs);
          if (syncRef.current) jumpToRef.current(snappedMs);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
        onPanResponderTerminate: () => {
          Haptics.selectionAsync();
        },
      }),
    []
  );

  const onVolumeChangeRef = useRef(onVolumeChange);
  onVolumeChangeRef.current = onVolumeChange;
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const volumeStart = useRef(volume);
  const lastVolumeEmit = useRef(volume);

  const volumePan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          volumeStart.current = volumeRef.current;
          Haptics.selectionAsync();
        },
        onPanResponderMove: (_, gs) => {
          const next = Math.max(
            0,
            Math.min(1, volumeStart.current + gs.dx / 220)
          );
          if (Math.abs(next - lastVolumeEmit.current) < 0.005) return;
          lastVolumeEmit.current = next;
          setVolume(next);
          onVolumeChangeRef.current?.(next);
        },
        onPanResponderRelease: () => {
          lastVolumeEmit.current = volumeRef.current;
          Haptics.selectionAsync();
        },
        onPanResponderTerminate: () => {
          lastVolumeEmit.current = volumeRef.current;
        },
      }),
    // setVolume is a stable state setter — safe to capture once.
    [setVolume]
  );

  const bracketPx = bracketPos * WAVEFORM_W;
  const bracketW = bracketRatio * WAVEFORM_W;
  const volPct = Math.round(volume * 100);

  // Single-flight guard — prevent double-tap duplicate confirm. (G19)
  const handleConfirm = useConfirmOnce(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onConfirm(bracketStartMs, volume);
  });

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* Video preview */}
      <View style={[styles.video, { height: SCREEN_W * 0.46 }]}>
        {isReady && playerRef.current ? (
          <VideoView
            player={playerRef.current}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            nativeControls={false}
          />
        ) : null}
        {videoError && (
          <View style={[StyleSheet.absoluteFill, { backgroundColor: "#000", alignItems: "center", justifyContent: "center" }]}>
            <Ionicons name="warning-outline" size={28} color={colors.accent} />
            <Text style={[{ fontFamily: font.thin, color: colors.accent, marginTop: 8, fontSize: 12 }]}>
              video failed to load
            </Text>
          </View>
        )}
        {!syncWithClock && (
          <TouchableOpacity
            onPress={togglePlay}
            style={[styles.playBtn, { backgroundColor: colors.overlay }]}
          >
            <Ionicons name={isPlaying ? "pause" : "play"} size={26} color={colors.onDark} />
          </TouchableOpacity>
        )}
        <View style={[styles.badge, { backgroundColor: colors.overlay }]}>
          <Text style={[styles.badgeText, { fontFamily: font.thin, color: colors.primary }]}>
            Layer {loopNumber} · {formatTime(masterDuration)}
            {syncWithClock ? " · SYNCED" : ""}
          </Text>
        </View>
      </View>

      {/* Timeline */}
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>
          FULL RECORDING
        </Text>
        <Text style={[styles.instruction, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          {syncWithClock
            ? "Step the bracket one beat at a time — every layer keeps looping"
            : "Slide the bracket to choose your section"}
        </Text>

        {/* Waveform + bracket */}
        <View style={{ position: "relative", height: 72 }} {...pan.panHandlers}>
          <WaveformBars
            data={waveformData}
            width={WAVEFORM_W}
            height={72}
            startRatio={0}
            endRatio={0}
            activeColor={colors.waveInactive}
            inactiveColor={colors.waveInactive}
          />
          {/* Dimmed outside bracket */}
          <View style={[StyleSheet.absoluteFill, { backgroundColor: `${colors.background}88` }]} />
          {/* Bracket window */}
          <View
            style={[
              styles.bracket,
              {
                left: bracketPx,
                width: bracketW,
                borderColor: colors.primary,
                backgroundColor: `${colors.primary}12`,
              },
            ]}
          >
            {/* Master beat grid inside the bracket */}
            {safeBeatsPerLoop > 1 && (
              <View pointerEvents="none" style={StyleSheet.absoluteFill}>
                {Array.from({ length: safeBeatsPerLoop - 1 }).map((_, i) => (
                  <View
                    key={i}
                    style={[
                      styles.beatLine,
                      {
                        left: `${((i + 1) / safeBeatsPerLoop) * 100}%`,
                        backgroundColor: `${colors.onDark}55`,
                      },
                    ]}
                  />
                ))}
              </View>
            )}
          </View>
          {/* Active bars inside bracket (clip via overflow hidden) */}
          <View style={[styles.activeClip, { left: bracketPx, width: bracketW }]}>
            <View style={{ marginLeft: -bracketPx }}>
              <WaveformBars
                data={waveformData}
                width={WAVEFORM_W}
                height={72}
                startRatio={bracketPos}
                endRatio={bracketPos + bracketRatio}
                activeColor={colors.primary}
                inactiveColor="transparent"
              />
            </View>
          </View>
          {/* Red playhead — the exact playback position inside the recording */}
          <Animated.View
            pointerEvents="none"
            style={[styles.playhead, playheadStyle]}
          />
          {/* Edge handles */}
          <View style={[styles.edgeHandle, { left: bracketPx - 1.5, backgroundColor: colors.primary }]} />
          <View style={[styles.edgeHandle, { left: bracketPx + bracketW - 1.5, backgroundColor: colors.primary }]} />
        </View>

        {/* Beat-step arrows — move the envelope back or forward by one beat */}
        <View style={styles.arrowRow}>
          <TouchableOpacity
            onPress={() => stepBracket(-1)}
            disabled={!canLeft}
            style={[
              styles.arrowBtn,
              { borderColor: colors.border, opacity: canLeft ? 1 : 0.3 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Move bracket one beat earlier"
          >
            <Ionicons name="chevron-back" size={20} color={colors.foreground} />
          </TouchableOpacity>
          <Text style={[styles.arrowLabel, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
            SECTION {sectionIndex} OF {maxSections}
          </Text>
          <TouchableOpacity
            onPress={() => stepBracket(1)}
            disabled={!canRight}
            style={[
              styles.arrowBtn,
              { borderColor: colors.border, opacity: canRight ? 1 : 0.3 },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Move bracket one beat later"
          >
            <Ionicons name="chevron-forward" size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        {/* Layer volume */}
        <View style={styles.volumeRow}>
          <Ionicons
            name={volume === 0 ? "volume-mute-outline" : volume < 0.45 ? "volume-low-outline" : "volume-high-outline"}
            size={15}
            color={colors.mutedForeground}
          />
          <View style={styles.volumeWrap} {...volumePan.panHandlers}>
            <View style={[styles.volumeTrack, { backgroundColor: colors.muted }]}>
              <View style={[styles.volumeFill, { width: `${volPct}%`, backgroundColor: colors.primary }]} />
              <View style={[styles.volumeThumb, { left: `${volPct}%`, backgroundColor: colors.primary }]} />
            </View>
          </View>
          <Text style={[styles.volumeLabel, { fontFamily: font.thin, color: colors.mutedForeground }]}>
            LAYER VOLUME
          </Text>
        </View>

        {/* Readout — coarse, uncluttered */}
        <View style={[styles.timeRow, { backgroundColor: colors.cardAlt }]}>
          <View style={styles.timeCell}>
            <Text style={[styles.timeLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>START</Text>
            <Text style={[styles.timeVal, { fontFamily: font.mono, color: colors.foreground }]}>{formatTime(bracketStartMs)}</Text>
          </View>
          <View style={[styles.timeDivider, { backgroundColor: colors.border }]} />
          <View style={styles.timeCell}>
            <Text style={[styles.timeLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>END</Text>
            <Text style={[styles.timeVal, { fontFamily: font.mono, color: colors.foreground }]}>{formatTime(Math.min(bracketEndMs, duration))}</Text>
          </View>
          <View style={[styles.timeDivider, { backgroundColor: colors.border }]} />
          <View style={styles.timeCell}>
            <Text style={[styles.timeLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>TIME</Text>
            <Text style={[styles.timeVal, { fontFamily: font.mono, color: colors.primary }]}>{formatTime(masterDuration)}</Text>
          </View>
        </View>
      </View>

      {/* Action — the sheet header ✕ discards */}
      <View style={styles.actions}>
        {takeInvalid && (
          <View style={[styles.shortTake, { backgroundColor: colors.cardAlt, borderColor: colors.primary }]}>
            <Ionicons name="warning-outline" size={16} color={colors.primary} />
            <Text style={[styles.shortTakeText, { fontFamily: font.thin, color: colors.foreground }]}>
              Take shorter than the loop length ({formatTime(masterDuration)}) — record again.
            </Text>
          </View>
        )}
        <TouchableOpacity
          testID="browser-confirm"
          onPress={handleConfirm}
          style={[styles.btnPri, { backgroundColor: colors.primary, opacity: takeInvalid ? 0.35 : 1 }]}
          disabled={takeInvalid}
        >
          <Text style={[styles.btnPriTxt, { fontFamily: font.thin, color: colors.primaryForeground }]}>
            {confirmLabel ?? `Add Layer ${loopNumber}`}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  video: { width: "100%", backgroundColor: "#000", alignItems: "center", justifyContent: "center" },
  playBtn: { width: 54, height: 54, borderRadius: 27, alignItems: "center", justifyContent: "center" },
  badge: {
    position: "absolute", bottom: 12, right: 12,
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: 16,
  },
  badgeText: { fontSize: 12 },
  section: { paddingHorizontal: PAD, paddingTop: 18, gap: 12 },
  sectionLabel: { fontSize: 10 },
  instruction: { fontSize: 12, marginTop: -4 },
  bracket: {
    position: "absolute", top: 0, bottom: 0,
    borderWidth: 1.5, borderRadius: 3,
  },
  beatLine: {
    position: "absolute", top: 0, bottom: 0,
    width: StyleSheet.hairlineWidth,
  },
  activeClip: { position: "absolute", top: 0, bottom: 0, overflow: "hidden" },
  edgeHandle: { position: "absolute", top: 6, bottom: 6, width: 3, borderRadius: 2 },
  playhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: "#E2483D",
  },
  arrowRow: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 18, paddingVertical: 2 },
  arrowBtn: {
    width: 46, height: 46, borderRadius: 23, borderWidth: 1,
    alignItems: "center", justifyContent: "center",
  },
  arrowLabel: { fontSize: 12, minWidth: 110, textAlign: "center" },
  volumeRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  volumeWrap: { flex: 1, height: 26, justifyContent: "center" },
  volumeTrack: { height: 3, borderRadius: 2 },
  volumeFill: { position: "absolute", left: 0, top: 0, height: 3, borderRadius: 2 },
  volumeThumb: {
    position: "absolute",
    top: -5,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    marginLeft: -6.5,
  },
  volumeLabel: { fontSize: 9, letterSpacing: 1.2, width: 78, textAlign: "right" },
  timeRow: { flexDirection: "row", borderRadius: 12, overflow: "hidden" },
  timeCell: { flex: 1, paddingVertical: 10, alignItems: "center", gap: 4 },
  timeLabel: { fontSize: 9 },
  timeVal: { fontSize: 13 },
  timeDivider: { width: StyleSheet.hairlineWidth, marginVertical: 8 },
  actions: { flexDirection: "column", gap: 10, paddingHorizontal: PAD, paddingTop: 14 },
  shortTake: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    borderRadius: 12, borderWidth: 1,
  },
  shortTakeText: { fontSize: 12, flex: 1 },
  btnPri: {
    flex: 1, paddingVertical: 15, borderRadius: 14,
    alignItems: "center", justifyContent: "center",
  },
  btnPriTxt: { fontSize: 15 },
});
