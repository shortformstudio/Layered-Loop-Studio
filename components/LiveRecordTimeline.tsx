import React, { useMemo } from "react";
import { StyleSheet, View } from "react-native";
import { useColors } from "@/hooks/useColors";

const BAR_COUNT = 72;

interface LiveRecordTimelineProps {
  /** Real amplitude samples (0..1) while recording — web analyser. Empty on native. */
  levels: number[];
  /** Elapsed recording time in ms — drives the native fill. */
  elapsedMs: number;
}

/**
 * Live take timeline — fills left to right while recording.
 *
 * Web: bars are real microphone amplitude from the WebAudio analyser.
 * Native: the camera recorder exposes no live metering, so bars fill with
 * time (neutral height); the analyzed waveform replaces this strip the
 * moment the take ends and the trim editor opens.
 */
export default function LiveRecordTimeline({ levels, elapsedMs }: LiveRecordTimelineProps) {
  const colors = useColors();

  const hasLevels = levels.length > 0;

  const bars = useMemo(() => {
    const out: { h: number; on: boolean }[] = [];
    for (let i = 0; i < BAR_COUNT; i++) {
      if (hasLevels) {
        const idx = Math.min(levels.length - 1, i);
        const h = Math.max(0.06, Math.min(1, levels[idx] ?? 0.06));
        out.push({ h, on: true });
      } else {
        // One bar per 150ms of recording — the timeline populates in real time.
        const on = elapsedMs >= i * 150;
        out.push({ h: on ? 0.38 : 0.06, on });
      }
    }
    return out;
  }, [levels, elapsedMs, hasLevels]);

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={styles.strip}>
        {bars.map((b, i) => (
          <View
            key={i}
            style={[
              styles.bar,
              {
                height: `${b.h * 100}%`,
                backgroundColor: b.on ? colors.primary : colors.border,
              },
            ]}
          />
        ))}
      </View>
      <View style={[styles.recDot, { backgroundColor: "#E2483D" }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 20,
  },
  strip: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 1.5,
    height: 44,
  },
  bar: {
    flex: 1,
    borderRadius: 2,
  },
  recDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
