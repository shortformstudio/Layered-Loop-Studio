import React, { useMemo, useRef } from "react";
import { PanResponder, StyleSheet, View } from "react-native";
import * as Haptics from "expo-haptics";
import { useColors } from "@/hooks/useColors";

interface VerticalFaderProps {
  value: number;
  onChange: (v: number) => void;
  height?: number;
}

/**
 * Vertical monitor volume fader — drag up/down to fade.
 *
 * Hardened gesture logic:
 *  - The PanResponder is created ONCE; live values flow through refs, so a
 *    value change mid-drag can never recreate the responder and reset the
 *    gesture (the classic fader jitter).
 *  - Position is computed from the grant-time snapshot plus the total
 *    gesture delta — never from a re-read of the updated value.
 *  - Emissions are coalesced (0.5% deadband) so the JS thread isn't spammed
 *    with duplicate writes.
 */
export default function VerticalFader({
  value,
  onChange,
  height = 150,
}: VerticalFaderProps) {
  const colors = useColors();

  const valueRef = useRef(value);
  valueRef.current = value;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const heightRef = useRef(height);
  heightRef.current = height;
  const grantStartRef = useRef(value);
  const lastEmittedRef = useRef(value);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          grantStartRef.current = valueRef.current;
          Haptics.selectionAsync().catch(() => {});
        },
        onPanResponderMove: (_, gs) => {
          const h = heightRef.current;
          if (h <= 0) return;
          const next = Math.max(
            0,
            Math.min(1, grantStartRef.current - gs.dy / h)
          );
          if (Math.abs(next - lastEmittedRef.current) < 0.005) return;
          lastEmittedRef.current = next;
          onChangeRef.current(next);
        },
        onPanResponderRelease: () => {
          lastEmittedRef.current = valueRef.current;
          Haptics.selectionAsync().catch(() => {});
        },
        onPanResponderTerminate: () => {
          lastEmittedRef.current = valueRef.current;
        },
      }),
    []
  );

  const pct = Math.round((Number.isFinite(value) ? value : 0) * 100);

  return (
    <View
      {...pan.panHandlers}
      style={[styles.track, { height, backgroundColor: colors.border }]}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel="Monitor volume"
      accessibilityValue={{ min: 0, max: 100, now: pct, text: `${pct}%` }}
    >
      <View
        pointerEvents="none"
        style={[
          styles.fill,
          { height: `${pct}%`, backgroundColor: colors.primary },
        ]}
      />
      <View
        pointerEvents="none"
        style={[
          styles.thumb,
          { bottom: `${pct}%`, backgroundColor: colors.foreground },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: 26,
    borderRadius: 13,
    alignItems: "center",
    justifyContent: "flex-end",
    overflow: "hidden",
  },
  fill: {
    width: "100%",
  },
  thumb: {
    position: "absolute",
    width: 20,
    height: 20,
    borderRadius: 10,
    transform: [{ translateY: 10 }],
  },
});
