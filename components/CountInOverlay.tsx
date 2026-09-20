import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";

interface BeatCircleProps {
  beat: number;
  active: boolean;
  label: string;
}

function BeatCircle({ beat, active, label }: BeatCircleProps) {
  const colors = useColors();
  const scale = useSharedValue(1);
  const opacity = useSharedValue(0.2);

  useEffect(() => {
    if (active) {
      scale.value = withSequence(
        withTiming(1.6, { duration: 70, easing: Easing.out(Easing.cubic) }),
        withTiming(1.0, { duration: 320, easing: Easing.inOut(Easing.ease) }),
      );
      opacity.value = withSequence(
        withTiming(1, { duration: 60 }),
        withTiming(0.2, { duration: 350 }),
      );
    }
  }, [active]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
    opacity: opacity.value,
  }));

  return (
    <Animated.View style={animStyle}>
      <View
        style={[
          styles.circle,
          {
            backgroundColor: active ? colors.primary : "transparent",
            borderColor: active ? colors.primary : colors.onDark,
          },
        ]}
      >
        <Text
          style={[
            styles.circleLabel,
            {
              fontFamily: font.thin,
              color: active ? colors.primaryForeground : colors.onDark,
            },
          ]}
        >
          {label}
        </Text>
      </View>
    </Animated.View>
  );
}

interface CountInOverlayProps {
  beatCount: number;
  beatIntervalMs: number;
  startDelayMs: number;
  onComplete: () => void;
}

export default function CountInOverlay({
  beatCount,
  beatIntervalMs,
  startDelayMs,
  onComplete,
}: CountInOverlayProps) {
  const colors = useColors();
  const [activeBeat, setActiveBeat] = useState(0);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const beatCountRef = useRef(beatCount);
  const beatIntervalRef = useRef(beatIntervalMs);
  const onCompleteRef = useRef(onComplete);

  beatCountRef.current = beatCount;
  beatIntervalRef.current = beatIntervalMs;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    const tickBeat = (beat: number) => {
      const count = beatCountRef.current;
      const interval = beatIntervalRef.current;
      if (beat <= count) {
        setActiveBeat(beat);
        if (beat === count) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
        } else if (beat > 0) {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
        }
        if (beat < count) {
          timerRef.current = setTimeout(() => tickBeat(beat + 1), interval);
        } else {
          timerRef.current = setTimeout(() => {
            setActiveBeat(0);
            onCompleteRef.current();
          }, interval);
        }
      }
    };

    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
    if (startDelayMs > 0) {
      timerRef.current = setTimeout(() => tickBeat(1), startDelayMs);
    } else {
      tickBeat(1);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [startDelayMs]);

  const labelFor = (b: number) => (b === beatCount ? ">" : String(beatCount - b));

  return (
    // Floating count-in — no full-screen scrim. The camera/stage stays fully
    // visible while the beats count down; only a small glass pill sits
    // behind the beat circles for readability.
    <View style={styles.overlay} pointerEvents="none">
      <View style={[styles.pill, { backgroundColor: "rgba(10,13,20,0.52)" }]}>
        <Text
          style={[
            styles.label,
            { fontFamily: font.thin, color: colors.onDark, letterSpacing: tracking.wide },
          ]}
        >
          COUNT IN
        </Text>
        <View style={styles.beatsRow}>
          {Array.from({ length: beatCount }, (_, i) => i + 1).map((b) => (
            <BeatCircle
              key={b}
              beat={b}
              active={activeBeat === b}
              label={labelFor(b)}
            />
          ))}
        </View>
        <Text style={[styles.sub, { fontFamily: font.thin, color: `${colors.onDark}80` }]}>
          recording on 1
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 50,
  },
  pill: {
    alignItems: "center",
    gap: 18,
    paddingVertical: 20,
    paddingHorizontal: 30,
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.12)",
  },
  label: { fontSize: 11 },
  beatsRow: { flexDirection: "row", gap: 18 },
  circle: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  circleLabel: { fontSize: 24 },
  sub: { fontSize: 12 },
});
