import React, { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedProps,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Svg, { Circle } from "react-native-svg";
import { useColors } from "@/hooks/useColors";

const SIZE = 116;
const R = 54;
const C = 2 * Math.PI * R;

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

interface ArmRingProps {
  /** 1 = the whole loop still to be played · 0 = the boundary is here */
  remainingFrac: number;
  /** Beat grid divisions — drawn as fixed ticks on the track */
  beats: number;
}

/**
 * The armed count-in, rendered as light: the remaining segment of the master
 * loop glows and closes in toward twelve o'clock. Recording begins the
 * moment it closes — no numerals, only the length of the loop being played.
 */
export default function ArmRing({ remainingFrac, beats }: ArmRingProps) {
  const colors = useColors();
  // Guard against NaN remainingFrac (edge case). (LOW fix.)
  const safeFrac = Number.isFinite(remainingFrac) ? remainingFrac : 0;
  const frac = useSharedValue(Math.max(0, Math.min(1, safeFrac)));

  useEffect(() => {
    frac.value = withTiming(Math.max(0, Math.min(1, safeFrac)), {
      duration: 110,
      easing: Easing.linear,
    });
  }, [safeFrac, frac]);

  const arcProps = useAnimatedProps(() => ({
    strokeDashoffset: C * (1 - frac.value),
  }));
  const rotateStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${(1 - frac.value) * 360}deg` }],
  }));

  // Guard against unbounded beats count.
  const safeBeats = Math.max(1, Math.min(32, Math.round(beats) || 4));
  const ticks = Array.from({ length: safeBeats }, (_, i) => (i / safeBeats) * 360);

  return (
    <View style={styles.wrap} pointerEvents="none">
      {/* Fixed layer — the loop track and its beat grid */}
      <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} style={StyleSheet.absoluteFill}>
        <Circle
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          stroke={colors.muted}
          strokeWidth={3.5}
          fill="none"
          opacity={0.85}
        />
        {ticks.map((deg) => {
          const rad = (deg * Math.PI) / 180 - Math.PI / 2;
          const x = SIZE / 2 + Math.cos(rad) * R;
          const y = SIZE / 2 + Math.sin(rad) * R;
          return (
            <Circle
              key={deg}
              cx={x}
              cy={y}
              r={1.6}
              fill={colors.mutedForeground}
              opacity={0.8}
            />
          );
        })}
      </Svg>

      {/* Sweeping layer — the remaining loop, closing toward the top */}
      <Animated.View style={[StyleSheet.absoluteFill, rotateStyle]}>
        <Svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`}>
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={colors.armedYellow}
            strokeWidth={9}
            fill="none"
            opacity={0.26}
            strokeLinecap="round"
            strokeDasharray={`${C} ${C}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            animatedProps={arcProps}
          />
          <AnimatedCircle
            cx={SIZE / 2}
            cy={SIZE / 2}
            r={R}
            stroke={colors.armedYellow}
            strokeWidth={3.5}
            fill="none"
            strokeLinecap="round"
            strokeDasharray={`${C} ${C}`}
            transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
            animatedProps={arcProps}
          />
        </Svg>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: "absolute",
    width: SIZE,
    height: SIZE,
    top: (80 - SIZE) / 2,
    left: (80 - SIZE) / 2,
  },
});
