import React, { useEffect } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  runOnJS,
} from "react-native-reanimated";
import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";

interface ToastHUDProps {
  message: string | null;
  onDismiss: () => void;
  topOffset?: number;
}

export default function ToastHUD({
  message,
  onDismiss,
  topOffset = 64,
}: ToastHUDProps) {
  const colors = useColors();
  const opacity = useSharedValue(0);
  const translateY = useSharedValue(-12);

  useEffect(() => {
    if (!message) {
      opacity.value = withTiming(0, { duration: 180 });
      translateY.value = withTiming(-12, { duration: 180 });
      return;
    }

    // Slide in, hold, slide out
    opacity.value = withTiming(1, { duration: 220 });
    translateY.value = withTiming(0, { duration: 220 });

    const timer = setTimeout(() => {
      opacity.value = withTiming(0, { duration: 240 });
      translateY.value = withTiming(-10, { duration: 240 }, (finished) => {
        if (finished) {
          runOnJS(onDismiss)();
        }
      });
    }, 2400);

    return () => clearTimeout(timer);
  }, [message, onDismiss, opacity, translateY]);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
    transform: [{ translateY: translateY.value }],
  }));

  if (!message) return null;

  return (
    <View
      pointerEvents="none"
      style={[styles.container, { top: topOffset }]}
    >
      <Animated.View
        style={[
          styles.bubble,
          {
            backgroundColor: "rgba(10, 13, 20, 0.88)",
            borderColor: colors.border,
          },
          animStyle,
        ]}
      >
        <View style={[styles.dot, { backgroundColor: colors.primary }]} />
        <Text
          style={[
            styles.text,
            {
              fontFamily: font.thin,
              color: colors.foreground,
              letterSpacing: tracking.wide,
            },
          ]}
          numberOfLines={2}
        >
          {message}
        </Text>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 100,
  },
  bubble: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 20,
    borderWidth: 1,
    maxWidth: "85%",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.25,
    shadowRadius: 10,
    elevation: 8,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  text: {
    fontSize: 12,
    textAlign: "center",
  },
});
