/**
 * MonitorCompact — the monitor control that lives left of the record
 * button, in every phase. Tap toggles the monitor instantly; long-press
 * opens the full monitor settings sheet. The glyph mirrors the verified
 * route (headphones / bluetooth / speaker / earpiece).
 */
import React from "react";
import { Alert, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";

import { useColors } from "@/hooks/useColors";
import { routeIcon, type MonitorRoute } from "@/components/MonitorSheet";

interface MonitorCompactProps {
  monitorOn: boolean;
  route: MonitorRoute;
  onToggle: () => void;
  onOpenSettings: () => void;
}

export default function MonitorCompact({
  monitorOn,
  route,
  onToggle,
  onOpenSettings,
}: MonitorCompactProps) {
  const colors = useColors();

  const handlePress = () => {
    if (!monitorOn && (route === "speaker" || route === "auto")) {
      Alert.alert(
        "Acoustic Feedback Risk",
        "Enabling monitor while routed to internal speakers can cause loud acoustic feedback loops into your microphone. We recommend using headphones.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Enable Anyway",
            style: "destructive",
            onPress: () => {
              onToggle();
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            },
          },
        ]
      );
    } else {
      onToggle();
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  };

  return (
    <TouchableOpacity
      onPress={handlePress}
      onLongPress={() => {
        onOpenSettings();
        Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }}
      delayLongPress={350}
      style={[
        styles.btn,
        {
          backgroundColor: monitorOn ? `${colors.primary}18` : "transparent",
          borderColor: monitorOn ? colors.primary : colors.border,
        },
      ]}
      accessibilityRole="button"
      accessibilityLabel={monitorOn ? "Monitor on — tap to mute, long-press for settings" : "Monitor off — tap to enable, long-press for settings"}
      accessibilityState={{ selected: monitorOn }}
      hitSlop={6}
    >
      <Ionicons
        name={routeIcon(route, monitorOn)}
        size={18}
        color={monitorOn ? colors.primary : colors.mutedForeground}
      />
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
