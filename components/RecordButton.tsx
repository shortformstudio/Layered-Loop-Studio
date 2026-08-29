import React, { useEffect } from "react";
import { StyleSheet, TouchableOpacity, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { useColors } from "@/hooks/useColors";

interface RecordButtonProps {
  isRecording: boolean;
  isArmed: boolean;
  /** Increments on each master downbeat while recording — gold ring pulse. */
  beatFlashKey?: number;
  onPress: () => void;
  disabled?: boolean;
}

export default function RecordButton({ isRecording, isArmed, beatFlashKey = 0, onPress, disabled }: RecordButtonProps) {
  const colors = useColors();
  const pulse = useSharedValue(1);
  const ringOpacity = useSharedValue(0);
  const ringScale = useSharedValue(1);
  const triggeredOpacity = useSharedValue(0);
  const goldOpacity = useSharedValue(0);
  const goldScale = useSharedValue(1);

  useEffect(() => {
    if (beatFlashKey === 0) return;
    goldScale.value = 0.9;
    goldOpacity.value = withSequence(
      withTiming(1, { duration: 70 }),
      withTiming(0, { duration: 380 })
    );
    goldScale.value = withTiming(1.4, { duration: 450 });
  }, [beatFlashKey, goldOpacity, goldScale]);

  useEffect(() => {
    if (isRecording) {
      pulse.value = withRepeat(
        withTiming(1.08, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        -1,
        true
      );
      ringOpacity.value = withRepeat(
        withTiming(0, { duration: 1000, easing: Easing.out(Easing.cubic) }),
        -1,
        false
      );
      ringScale.value = withRepeat(
        withTiming(1.5, { duration: 1000, easing: Easing.out(Easing.cubic) }),
        -1,
        false
      );
      triggeredOpacity.value = withTiming(0, { duration: 200 });
    } else if (isArmed) {
      pulse.value = 1;
      ringOpacity.value = 0;
      ringScale.value = 1;
      triggeredOpacity.value = 0;
    } else {
      pulse.value = withTiming(1, { duration: 300 });
      ringOpacity.value = withTiming(0, { duration: 200 });
      ringScale.value = withTiming(1, { duration: 200 });
      triggeredOpacity.value = withTiming(0, { duration: 200 });
    }
  }, [isRecording, isArmed]);

  const buttonStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
    opacity: disabled ? 0.3 : 1,
  }));

  const ringStyle = useAnimatedStyle(() => ({
    opacity: ringOpacity.value,
    transform: [{ scale: ringScale.value }],
  }));

  const goldStyle = useAnimatedStyle(() => ({
    opacity: goldOpacity.value,
    transform: [{ scale: goldScale.value }],
  }));

  const handlePress = () => {
    Haptics.impactAsync(
      isRecording
        ? Haptics.ImpactFeedbackStyle.Heavy
        : Haptics.ImpactFeedbackStyle.Medium
    );
    onPress();
  };

  const getBorderColor = () => {
    if (isRecording) return colors.recordRed;
    if (isArmed) return colors.armedYellow;
    return colors.foreground;
  };

  const getInnerColor = () => {
    if (isRecording) return colors.recordRed;
    if (isArmed) return colors.armedYellow;
    return colors.accent;
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      disabled={disabled}
      activeOpacity={0.9}
      style={styles.wrapper}
      accessibilityRole="button"
      accessibilityLabel={
        isRecording ? "Stop recording"
        : isArmed ? "Cancel armed recording"
        : "Start recording"
      }
      accessibilityState={{ disabled: disabled ?? false }}
    >
      {isRecording && (
        <Animated.View
          style={[styles.ring, { borderColor: colors.recordRed }, ringStyle]}
        />
      )}

      {/* Downbeat flash — gold ring pulse at each master boundary */}
      <Animated.View
        pointerEvents="none"
        style={[styles.ring, { borderColor: colors.primary, borderWidth: 2 }, goldStyle]}
      />

      <Animated.View style={buttonStyle}>
        <View
          style={[
            styles.outer,
            {
              borderColor: getBorderColor(),
              borderWidth: isArmed ? 1.5 : isRecording ? 1.5 : 1,
            },
          ]}
        >
          {/* Inner shape: circle (idle/armed), rounded square (recording) */}
          {isArmed ? (
            // Yellow armed indicator — filled circle
            <View
              style={[
                styles.inner,
                {
                  backgroundColor: colors.armedYellow,
                  borderRadius: 32,
                  width: 48,
                  height: 48,
                  alignItems: "center",
                  justifyContent: "center",
                },
              ]}
            >
              <Ionicons name="arrow-forward" size={22} color={colors.foreground} />
            </View>
          ) : (
            <View
              style={[
                styles.inner,
                {
                  backgroundColor: getInnerColor(),
                  borderRadius: isRecording ? 8 : 32,
                  width: isRecording ? 26 : 48,
                  height: isRecording ? 26 : 48,
                },
              ]}
            />
          )}
        </View>
      </Animated.View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  wrapper: {
    width: 80,
    height: 80,
    alignItems: "center",
    justifyContent: "center",
  },
  ring: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 1,
  },
  outer: {
    width: 64,
    height: 64,
    borderRadius: 32,
    alignItems: "center",
    justifyContent: "center",
  },
  inner: {},
});
