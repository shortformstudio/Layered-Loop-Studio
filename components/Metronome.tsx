/**
 * Metronome — a sweeping anchor that rides the root loop from beginning to
 * end: the dot travels down the rail across the loop's length, snaps back to
 * the top at the boundary, and pulses on every beat.
 *
 * Driven by the shared playback clock, so the sweep stays locked to the
 * master tempo even when individual video layers drift. Reduced-motion
 * devices get an opacity flash instead of the sweep + pulse.
 */
import React, { useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";

import { useLoops } from "@/context/LoopContext";
import { useColors } from "@/hooks/useColors";

/** Rail height — mirrors the monitor fader so the rails stay balanced. */
const RAIL_HEIGHT = 160;
/** Dot travel: the sweep spans this many px, top to bottom. */
const TRAVEL = 132;

interface MetronomeProps {
  beatsPerLoop: number;
  /** Sweeps only while playback is running */
  active: boolean;
  /** Larger dot while recording — the grid must stay readable even with the monitor off */
  prominent?: boolean;
}

export default function Metronome({ beatsPerLoop, active, prominent = false }: MetronomeProps) {
  const colors = useColors();
  const { masterDuration, subscribePlayback, isGlobalPlaying } = useLoops();
  const reduced = useReducedMotion();

  const scale = useSharedValue(1);
  const flash = useSharedValue(0.5);
  const translateY = useSharedValue(0);
  const beatIdx = useRef(-1);

  const mdRef = useRef(masterDuration);
  const bplRef = useRef(beatsPerLoop);
  mdRef.current = masterDuration;
  bplRef.current = beatsPerLoop;

  useEffect(() => {
    const running = active && isGlobalPlaying;
    if (!running) {
      scale.value = withTiming(1, { duration: 200 });
      flash.value = withTiming(0.5, { duration: 200 });
      translateY.value = withTiming(0, { duration: 260 });
      beatIdx.current = -1;
      return;
    }
    return subscribePlayback((pos) => {
      const md = mdRef.current;
      if (!md || md <= 0) return;

      // Sweep — the dot rides the loop from beginning to end.
      const frac = ((pos % md) + md) % md / md;
      if (!reduced) {
        translateY.value = withTiming(frac * TRAVEL, {
          duration: 110,
          easing: Easing.linear,
        });
      }

      const beatMs = md / Math.max(2, bplRef.current);
      const idx = Math.floor(pos / beatMs);
      if (idx === beatIdx.current) return;
      beatIdx.current = idx;
      if (reduced) {
        flash.value = 1;
        flash.value = withTiming(0.5, { duration: 240 });
      } else {
        scale.value = withTiming(prominent ? 1.35 : 1.45, { duration: 90, easing: Easing.out(Easing.quad) }, () => {
          scale.value = withTiming(1, { duration: 240, easing: Easing.inOut(Easing.ease) });
        });
      }
    });
  }, [active, isGlobalPlaying, subscribePlayback, reduced, prominent]);

  const animStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
    opacity: flash.value,
  }));

  return (
    <View style={styles.wrap} pointerEvents="none">
      <View style={[styles.track, { backgroundColor: colors.muted }]} />
      <Animated.View
        style={[
          styles.dot,
          {
            width: prominent ? 18 : 12,
            height: prominent ? 18 : 12,
            borderRadius: prominent ? 9 : 6,
            borderColor: colors.primary,
            backgroundColor: `${colors.primary}30`,
          },
          animStyle,
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    width: 26,
    height: RAIL_HEIGHT,
    alignItems: "center",
  },
  track: {
    position: "absolute",
    top: 6,
    bottom: 6,
    width: 1,
  },
  dot: {
    position: "absolute",
    top: 6,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 1,
  },
});
