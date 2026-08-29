import React, { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { ResizeMode, Video } from "expo-av";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { Gesture, GestureDetector } from "react-native-gesture-handler";

import { useLoops } from "@/context/LoopContext";
import { useColors } from "@/hooks/useColors";
import { useClockSyncedPreview } from "@/hooks/useClockSyncedPreview";
import { useConfirmOnce } from "@/hooks/useConfirmOnce";
import { nudgeBracket } from "@/lib/loopModel";
import { font, tracking } from "@/constants/typography";
import WaveformBars from "@/components/WaveformBars";

const WAVE_H = 44;

interface EnvelopeDockProps {
  /** Opens the full TimelineBrowser editor for this take. */
  onExpand: () => void;
  /** Mutes the hidden audition video when the full editor takes over. */
  auditionActive: boolean;
  /** Overrides the keep action — camera chains confirm → arm next take. */
  onKeep?: () => void;
}

/**
 * Provisional envelope dock — the take is already committed at its default
 * tail envelope and joining the stack. This dock lets the performer adjust
 * the envelope in place (drag + beat arrows), keep (✓ / any next intent),
 * discard (✕ / swipe down), or open the full editor.
 */
export default function EnvelopeDock({
  onExpand,
  auditionActive,
  onKeep,
}: EnvelopeDockProps) {
  const colors = useColors();
  const {
    pendingLoop,
    pendingBracketMs,
    nudgePendingBracket,
    setPendingBracket,
    masterDuration,
    beatsPerLoop,
    confirmBracket,
    discardPending,
  } = useLoops();

  const [waveWidth, setWaveWidth] = useState(0);

  const previewRef = useRef<Video>(null);
  const bracketMsRef = useRef(pendingBracketMs);
  bracketMsRef.current = pendingBracketMs;
  const { videoPosRef, jumpTo } = useClockSyncedPreview(
    previewRef,
    bracketMsRef,
    auditionActive,
    masterDuration ?? 0
  );

  if (!pendingLoop || masterDuration === null) return null;

  const duration = Math.max(pendingLoop.duration, 1);
  const bracketRatio = Math.min(1, masterDuration / duration);
  const beatUnitMs = masterDuration / Math.max(1, beatsPerLoop);
  const maxBracketMs = Math.max(0, duration - masterDuration);
  const beatIndex = Math.round(pendingBracketMs / beatUnitMs);
  const maxSections = Math.max(1, Math.floor(maxBracketMs / beatUnitMs) + 1);
  const sectionIndex = Math.min(maxSections, beatIndex + 1);
  const canLeft = pendingBracketMs > beatUnitMs / 2;
  const canRight = pendingBracketMs < maxBracketMs - beatUnitMs / 2;

  const bracketPx = (pendingBracketMs / duration) * waveWidth;
  const bracketW = bracketRatio * waveWidth;

  // ── Stable PanResponder (G24/G25/G26) ─────────────────────────────────
  // Created once with useMemo. Everything flows through refs so bracket
  // updates mid-drag never recreate the responder (recreation = dropped
  // gestures). Values clamped during move; snap on release + terminate.
  const pendingBracketMsRef = useRef(pendingBracketMs);
  pendingBracketMsRef.current = pendingBracketMs;
  const setPendingBracketRef = useRef(setPendingBracket);
  setPendingBracketRef.current = setPendingBracket;
  const jumpToRef = useRef(jumpTo);
  jumpToRef.current = jumpTo;
  const waveWidthRef = useRef(waveWidth);
  waveWidthRef.current = waveWidth;
  const durationRef = useRef(duration);
  durationRef.current = duration;
  const maxBracketMsRef = useRef(maxBracketMs);
  maxBracketMsRef.current = maxBracketMs;
  const beatUnitMsRef = useRef(beatUnitMs);
  beatUnitMsRef.current = beatUnitMs;

  const dragStart = useRef(0);
  const dragMsRef = useRef(0);

  const snapToBeat = useCallback((rawMs: number) => {
    const k = Math.round(rawMs / beatUnitMsRef.current);
    return Math.max(0, Math.min(maxBracketMsRef.current, k * beatUnitMsRef.current));
  }, []);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          dragStart.current = pendingBracketMsRef.current;
          dragMsRef.current = pendingBracketMsRef.current;
          Haptics.selectionAsync();
        },
        onPanResponderMove: (_, gs) => {
          const raw = dragStart.current + (gs.dx / Math.max(1, waveWidthRef.current)) * durationRef.current;
          const clamped = Math.max(0, Math.min(maxBracketMsRef.current, raw));
          dragMsRef.current = clamped;
          setPendingBracketRef.current(clamped);
          jumpToRef.current(clamped);
        },
        onPanResponderRelease: () => {
          const snapped = snapToBeat(dragMsRef.current);
          setPendingBracketRef.current(snapped);
          jumpToRef.current(snapped);
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
        onPanResponderTerminate: () => {
          // Interrupted drag — snap to nearest beat so the bracket isn't left raw.
          const snapped = snapToBeat(dragMsRef.current);
          setPendingBracketRef.current(snapped);
          jumpToRef.current(snapped);
        },
      }),
    [snapToBeat]
  );

  const step = (dir: -1 | 1) => {
    const next = nudgeBracket(pendingBracketMs, dir, {
      duration,
      masterDuration,
      beatsPerLoop,
    });
    nudgePendingBracket(dir);
    jumpTo(next);
  };

  // Single-flight guards — prevent double-tap duplicate commits. (G19)
  const handleDiscard = useConfirmOnce(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    discardPending();
  });
  const handleKeep = useConfirmOnce(() => {
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    if (onKeep) {
      onKeep();
    } else {
      confirmBracket();
    }
  });

  const swipeDown = Gesture.Pan()
    .activeOffsetY(18)
    .failOffsetX([-24, 24])
    .onEnd((e) => {
      if (e.translationY > 70 || e.velocityY > 900) {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        discardPending();
      }
    });

  return (
    <GestureDetector gesture={swipeDown}>
      <View style={styles.dock}>
        {/* Hidden audition video — audio only, clock-synced with the stack */}
        <Video
          ref={previewRef}
          source={{ uri: pendingLoop.uri }}
          style={styles.hiddenVideo}
          resizeMode={ResizeMode.COVER}
          shouldPlay={auditionActive}
          isLooping={false}
          isMuted={false}
          volume={1}
          onPlaybackStatusUpdate={(s) => {
            if (s.isLoaded) videoPosRef.current = s.positionMillis;
          }}
        />

        {/* Header — expand opens the full editor */}
        <TouchableOpacity
          onPress={onExpand}
          style={styles.header}
          accessibilityRole="button"
          accessibilityLabel="Open full envelope editor"
        >
          <Text style={[styles.title, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
            NEW LAYER · SECTION {sectionIndex} OF {maxSections}
          </Text>
          <Ionicons name="expand-outline" size={15} color={colors.mutedForeground} />
        </TouchableOpacity>

        {/* Mini waveform + bracket (drag to move, snaps on release) */}
        <View
          style={styles.waveWrap}
          onLayout={(e) => setWaveWidth(e.nativeEvent.layout.width)}
          {...pan.panHandlers}
        >
          {waveWidth > 0 && (
            <>
              <WaveformBars
                data={pendingLoop.waveformData}
                width={waveWidth}
                height={WAVE_H}
                startRatio={0}
                endRatio={0}
                activeColor={colors.waveInactive}
                inactiveColor={colors.waveInactive}
              />
              <View style={[StyleSheet.absoluteFill, { backgroundColor: `${colors.background}66` }]} />
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
              />
              <View style={[styles.activeClip, { left: bracketPx, width: bracketW }]}>
                <View style={{ marginLeft: -bracketPx }}>
                  <WaveformBars
                    data={pendingLoop.waveformData}
                    width={waveWidth}
                    height={WAVE_H}
                    startRatio={pendingBracketMs / duration}
                    endRatio={pendingBracketMs / duration + bracketRatio}
                    activeColor={colors.primary}
                    inactiveColor="transparent"
                  />
                </View>
              </View>
            </>
          )}
        </View>

        {/* Controls — beat arrows · discard · keep */}
        <View style={styles.controls}>
          <TouchableOpacity
            onPress={() => step(-1)}
            disabled={!canLeft}
            style={[styles.arrow, { borderColor: colors.border, opacity: canLeft ? 1 : 0.3 }]}
            accessibilityRole="button"
            accessibilityLabel="Envelope one beat earlier"
          >
            <Ionicons name="chevron-back" size={18} color={colors.foreground} />
          </TouchableOpacity>

          <View style={styles.centerRow}>
            <TouchableOpacity
              onPress={handleDiscard}
              style={[styles.miniBtn, { borderColor: colors.accent }]}
              accessibilityRole="button"
              accessibilityLabel="Discard take"
            >
              <Ionicons name="close" size={18} color={colors.accent} />
            </TouchableOpacity>
            <TouchableOpacity
              onPress={handleKeep}
              style={[styles.miniBtn, { backgroundColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Keep take"
            >
              <Ionicons name="checkmark" size={20} color={colors.primaryForeground} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity
            onPress={() => step(1)}
            disabled={!canRight}
            style={[styles.arrow, { borderColor: colors.border, opacity: canRight ? 1 : 0.3 }]}
            accessibilityRole="button"
            accessibilityLabel="Envelope one beat later"
          >
            <Ionicons name="chevron-forward" size={18} color={colors.foreground} />
          </TouchableOpacity>
        </View>

        <Text style={[styles.hint, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          swipe down to discard · anything you do next keeps this take
        </Text>
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  dock: {
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.14)",
    borderRadius: 20,
    backgroundColor: "rgba(18,24,36,0.55)",
    padding: 12,
    gap: 10,
  },
  hiddenVideo: {
    position: "absolute",
    width: 1,
    height: 1,
    opacity: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 11 },
  waveWrap: {
    height: WAVE_H,
    borderRadius: 8,
    overflow: "hidden",
  },
  bracket: {
    position: "absolute",
    top: 0,
    bottom: 0,
    borderWidth: 1.5,
    borderRadius: 3,
  },
  activeClip: {
    position: "absolute",
    top: 0,
    bottom: 0,
    overflow: "hidden",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10,
  },
  arrow: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  centerRow: { flexDirection: "row", gap: 10 },
  miniBtn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  hint: {
    fontSize: 10,
    letterSpacing: 0.4,
    textAlign: "center",
  },
});
