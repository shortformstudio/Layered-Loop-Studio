/**
 * StackedTimeline — full-width stacked waveform tracks.
 *
 * Each layer renders one horizontal waveform row spanning the full screen
 * width; rows stack vertically with the root loop anchored at the BOTTOM.
 * A single live playhead line sweeps across all rows in lockstep with the
 * shared playback clock. Tapping a row routes the user to the choose-section
 * phase for that layer (non-destructive trim / delete).
 */
import React, { useCallback, useEffect, useMemo, useRef } from "react";
import {
  PanResponder,
  StyleSheet,
  Text,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import Svg, { Line, Rect } from "react-native-svg";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";

import type { Loop } from "@/context/LoopContext";
import { useLoops } from "@/context/LoopContext";
import { useColors } from "@/hooks/useColors";
import { font } from "@/constants/typography";

const ROW_H = 54;
const ROW_GAP = 8;
const BAR_GAP = 1.5;
const BAR_COUNT = 72;
const LABEL_W = 44;

interface StackedTimelineProps {
  loops: Loop[];
  masterDuration: number | null;
  beatsPerLoop: number;
  soloedId: string | null;
  /** Tap a layer's timeline → choose-section phase for that loop */
  onEditLoop: (id: string) => void;
  onToggleMute: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onRemoveLoop: (id: string) => void;
  onBracketChange?: (id: string, bracketStartMs: number) => void;
  onAuditionSolo?: (id: string | null) => void;
}

/** Slice the loop's waveform to its phrase window, resampled to BAR_COUNT. */
function phraseBars(waveform: number[], startTrim: number, endTrim: number, duration: number): number[] {
  const bars: number[] = [];
  const dur = Math.max(1, duration);
  const s = Math.max(0, Math.min(startTrim, dur));
  const e = Math.max(s, Math.min(endTrim, dur));
  const span = Math.max(1, e - s);
  for (let i = 0; i < BAR_COUNT; i++) {
    const idx = Math.min(
      waveform.length - 1,
      Math.floor(((s + (i / BAR_COUNT) * span) / dur) * waveform.length)
    );
    bars.push(waveform[Math.max(0, idx)] ?? 0.35);
  }
  return bars;
}

function WaveformRow({
  loop,
  width,
  color,
  dimmed,
}: {
  loop: Loop;
  width: number;
  color: string;
  dimmed: boolean;
}) {
  const bars = useMemo(
    () => phraseBars(loop.waveformData, loop.startTrim, loop.endTrim, loop.duration),
    [loop.waveformData, loop.startTrim, loop.endTrim, loop.duration]
  );
  const barW = Math.max(1.5, (width - BAR_GAP * (BAR_COUNT - 1)) / BAR_COUNT);

  return (
    <Svg width={width} height={ROW_H}>
      {bars.map((v, i) => {
        const h = Math.max(3, v * (ROW_H - 12) * 0.92);
        const x = i * (barW + BAR_GAP);
        const y = (ROW_H - h) / 2;
        return (
          <Rect
            key={i}
            x={x}
            y={y}
            width={barW}
            height={h}
            rx={barW / 2}
            fill={color}
            opacity={dimmed ? 0.3 : 0.92}
          />
        );
      })}
    </Svg>
  );
}

function BeatGrid({ beats, width, color }: { beats: number; width: number; color: string }) {
  const lines = useMemo(() => {
    const ls: React.ReactElement[] = [];
    for (let b = 1; b < beats; b++) {
      const x = (b / beats) * width;
      ls.push(
        <Line key={b} x1={x} y1={6} x2={x} y2={ROW_H - 6} stroke={color} strokeWidth={0.75} strokeDasharray="3 4" />
      );
    }
    return ls;
  }, [beats, width]);
  return (
    <Svg width={width} height={ROW_H} style={StyleSheet.absoluteFill} pointerEvents="none">
      {lines}
    </Svg>
  );
}

interface TrackRowProps {
  loop: Loop;
  isMaster: boolean;
  isSoloed: boolean;
  rowColor: string;
  dimmed: boolean;
  waveW: number;
  beatsPerLoop: number;
  masterDuration: number | null;
  onEdit: (id: string) => void;
  onToggleSolo: (id: string) => void;
  onToggleMute: (id: string) => void;
  onRemove: (id: string) => void;
  onBracketChange?: (id: string, bracketStartMs: number) => void;
  onAuditionSolo?: (id: string | null) => void;
  colors: ReturnType<typeof useColors>;
}

function TrackRow({
  loop,
  isMaster,
  isSoloed,
  rowColor,
  dimmed,
  waveW,
  beatsPerLoop,
  masterDuration,
  onEdit,
  onToggleSolo,
  onToggleMute,
  onRemove,
  onBracketChange,
  onAuditionSolo,
  colors,
}: TrackRowProps) {
  const md = masterDuration ?? 0;
  const beatMs = md > 0 && beatsPerLoop > 0 ? md / beatsPerLoop : 500;
  const initialBracket = useRef(loop.bracketStartMs);
  const maxBracket = Math.max(0, loop.fullRecordingDuration - (md || loop.duration));

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_, gs) =>
          !isMaster && Math.abs(gs.dx) > 8 && Math.abs(gs.dx) > Math.abs(gs.dy),
        onPanResponderGrant: () => {
          initialBracket.current = loop.bracketStartMs;
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        },
        onPanResponderMove: (_, gs) => {
          if (isMaster || !onBracketChange || maxBracket <= 0) return;
          const shiftBeats = Math.round((-gs.dx / waveW) * beatsPerLoop);
          const candidate = initialBracket.current + shiftBeats * beatMs;
          const clamped = Math.max(0, Math.min(maxBracket, candidate));
          if (Math.abs(clamped - loop.bracketStartMs) >= beatMs * 0.8) {
            onBracketChange(loop.id, clamped);
            Haptics.selectionAsync();
          }
        },
        onPanResponderRelease: () => {},
      }),
    [isMaster, onBracketChange, maxBracket, waveW, beatsPerLoop, beatMs, loop.bracketStartMs, loop.id]
  );

  return (
    <View style={styles.rowTouch}>
      <View style={[styles.labelCol, { width: LABEL_W }]}>
        <View
          style={[
            styles.badge,
            {
              backgroundColor: isMaster
                ? `${colors.primary}26`
                : isSoloed
                ? `${colors.accent}26`
                : colors.muted,
            },
          ]}
        >
          <Text
            style={[
              styles.badgeNum,
              {
                fontFamily: font.demi,
                color: isMaster
                  ? colors.primary
                  : isSoloed
                  ? colors.accent
                  : colors.mutedForeground,
              },
            ]}
          >
            {loop.layerIndex + 1}
          </Text>
        </View>
        {loop.syncState === "failed" && (
          <View style={[styles.syncDot, { backgroundColor: colors.accent }]} />
        )}
        {loop.syncState === "pending" && (
          <View style={[styles.syncDot, { backgroundColor: colors.primary }]} />
        )}
        <View style={styles.smRow}>
          <TouchableOpacity
            onPress={() => {
              Haptics.selectionAsync();
              onToggleSolo(loop.id);
            }}
            onPressIn={() => {
              if (onAuditionSolo) {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onAuditionSolo(loop.id);
              }
            }}
            onPressOut={() => {
              if (onAuditionSolo) {
                onAuditionSolo(null);
              }
            }}
            style={[
              styles.smBtn,
              {
                backgroundColor: isSoloed ? colors.accent : "transparent",
                borderColor: isSoloed ? colors.accent : colors.border,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Solo layer ${loop.layerIndex + 1} (press and hold to audition)`}
            accessibilityState={{ selected: isSoloed }}
            hitSlop={4}
          >
            <Text
              style={[
                styles.smTxt,
                {
                  fontFamily: font.thin,
                  color: isSoloed ? colors.onDark : colors.mutedForeground,
                },
              ]}
            >
              S
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => {
              Haptics.selectionAsync();
              onToggleMute(loop.id);
            }}
            style={[
              styles.smBtn,
              {
                backgroundColor: loop.muted ? `${colors.foreground}22` : "transparent",
                borderColor: loop.muted ? colors.foreground : colors.border,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Mute layer ${loop.layerIndex + 1}`}
            accessibilityState={{ selected: loop.muted }}
            hitSlop={4}
          >
            <Text
              style={[
                styles.smTxt,
                {
                  fontFamily: font.thin,
                  color: loop.muted ? colors.foreground : colors.mutedForeground,
                },
              ]}
            >
              M
            </Text>
          </TouchableOpacity>
        </View>
      </View>

      <TouchableOpacity
        activeOpacity={0.85}
        onPress={() => onEdit(loop.id)}
        style={[styles.wave, { width: waveW }]}
        {...panResponder.panHandlers}
        accessibilityLabel={`Layer ${loop.layerIndex + 1} — swipe horizontally to scrub bracket or tap to edit`}
      >
        <WaveformRow loop={loop} width={waveW} color={rowColor} dimmed={dimmed} />
        <BeatGrid beats={Math.max(2, beatsPerLoop)} width={waveW} color={`${colors.foreground}1E`} />
        {!loop.muted && (
          <View
            style={[
              styles.volLine,
              {
                width: `${(loop.volume ?? 1) * 100}%`,
                backgroundColor: isMaster ? colors.primary : colors.mutedForeground,
                opacity: 0.5,
              },
            ]}
          />
        )}
      </TouchableOpacity>

      <TouchableOpacity
        testID={`delete-layer-${loop.layerIndex + 1}`}
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onRemove(loop.id);
        }}
        style={styles.removeBtn}
        accessibilityRole="button"
        accessibilityLabel={`Delete layer ${loop.layerIndex + 1}`}
        hitSlop={6}
      >
        <Text style={[styles.removeX, { fontFamily: font.thin, color: colors.mutedForeground }]}>
          ×
        </Text>
      </TouchableOpacity>
    </View>
  );
}

export default function StackedTimeline({
  loops,
  masterDuration,
  beatsPerLoop,
  soloedId,
  onEditLoop,
  onToggleMute,
  onToggleSolo,
  onRemoveLoop,
  onBracketChange,
  onAuditionSolo,
}: StackedTimelineProps) {
  const colors = useColors();
  const { width: screenW } = useWindowDimensions();
  const waveW = screenW - LABEL_W - 30;

  const { subscribePlayback } = useLoops();

  const playheadX = useSharedValue(-1);
  const mdRef = useRef(masterDuration);
  mdRef.current = masterDuration;

  useEffect(() => {
    const unsub = subscribePlayback((pos) => {
      const md = mdRef.current;
      if (!md || md <= 0) {
        playheadX.value = -1;
        return;
      }
      const target = LABEL_W + (pos / md) * waveW;
      if (playheadX.value < 0) {
        playheadX.value = target;
      } else {
        playheadX.value = withTiming(target, { duration: 120 });
      }
    });
    return unsub;
  }, [subscribePlayback, waveW]);

  const playheadStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: playheadX.value }],
    opacity: playheadX.value < 0 ? 0 : 1,
  }));

  const handleRowPress = useCallback(
    (id: string) => {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      onEditLoop(id);
    },
    [onEditLoop]
  );

  // Root loop (layerIndex 0) anchors the bottom.
  const ordered = useMemo(() => [...loops].sort((a, b) => a.layerIndex - b.layerIndex), [loops]);
  const topToBottom = useMemo(() => [...ordered].reverse(), [ordered]);
  const trackCount = topToBottom.length;
  const totalH = trackCount * (ROW_H + ROW_GAP);

  return (
    <View style={styles.container}>
      {/* Playhead sweeps across every visible row */}
      <View style={[styles.playheadLayer, { height: totalH }]} pointerEvents="none">
        <Animated.View
          style={[styles.playhead, playheadStyle]}
        />
      </View>

      {topToBottom.map((loop, i) => {
        const isMaster = loop.layerIndex === 0;
        const isSoloed = loop.id === soloedId;
        const rowColor = isMaster ? colors.primary : isSoloed ? colors.accent : colors.waveActive;
        const dimmed = loop.muted;

        return (
          <View key={loop.id} style={[styles.rowWrap, { marginTop: i === 0 ? 0 : ROW_GAP }]}>
            <TrackRow
              loop={loop}
              isMaster={isMaster}
              isSoloed={isSoloed}
              rowColor={rowColor}
              dimmed={dimmed}
              waveW={waveW}
              beatsPerLoop={beatsPerLoop}
              masterDuration={masterDuration}
              onEdit={handleRowPress}
              onToggleSolo={onToggleSolo}
              onToggleMute={onToggleMute}
              onRemove={onRemoveLoop}
              onBracketChange={onBracketChange}
              onAuditionSolo={onAuditionSolo}
              colors={colors}
            />
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
    paddingHorizontal: 14,
    position: "relative",
  },
  playheadLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 20,
  },
  playhead: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    borderRadius: 1,
    backgroundColor: "#E2483D",
  },
  rowWrap: {
    flexDirection: "row",
    alignItems: "center",
  },
  rowTouch: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  labelCol: {
    alignItems: "center",
    justifyContent: "center",
    gap: 5,
    paddingRight: 6,
  },
  badge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: "center",
    justifyContent: "center",
  },
  badgeNum: { fontSize: 11 },
  syncDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    alignSelf: "center",
    marginTop: 2,
  },
  smRow: { flexDirection: "row", gap: 3 },
  smBtn: {
    width: 18,
    height: 18,
    borderRadius: 4,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  smTxt: { fontSize: 8, letterSpacing: 0.5 },
  wave: {
    height: ROW_H,
    position: "relative",
  },
  volLine: {
    position: "absolute",
    bottom: 1,
    left: 0,
    height: 2,
    borderRadius: 1,
  },
  removeBtn: {
    width: 24,
    height: ROW_H,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: 4,
  },
  removeX: { fontSize: 18, lineHeight: 20 },
});
