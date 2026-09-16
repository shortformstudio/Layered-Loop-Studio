/**
 * MonitorSheet — the monitor settings space. Bottom glass sheet with:
 *   monitor out toggle · volume · route verification (test tone +
 *   where-you-heard-it) · Android earpiece/speaker · done.
 * All labels lowercase, per house style.
 */
import React, { useMemo, useRef, useState } from "react";
import {
  Alert,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { BlurView } from "expo-blur";

import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";
import { playMonitorTestTone } from "@/utils/monitor-test";

export type MonitorRoute =
  | "auto"
  | "headphones"
  | "bluetooth"
  | "speaker"
  | "earpiece";

const ROUTES: { id: MonitorRoute; label: string; icon: keyof typeof Ionicons.glyphMap }[] = [
  { id: "auto", label: "auto", icon: "options-outline" },
  { id: "headphones", label: "headphones", icon: "headset" },
  { id: "bluetooth", label: "bluetooth", icon: "bluetooth" },
  { id: "speaker", label: "speaker", icon: "volume-high" },
  { id: "earpiece", label: "earpiece", icon: "call-outline" },
];

export function routeIcon(route: MonitorRoute, monitorOn: boolean): keyof typeof Ionicons.glyphMap {
  if (!monitorOn) return "volume-mute";
  const r = ROUTES.find((x) => x.id === route);
  return r ? r.icon : "headset-outline";
}

interface MonitorSheetProps {
  visible: boolean;
  onClose: () => void;
  monitorOn: boolean;
  onMonitorToggle: () => void;
  volume: number;
  onVolumeChange: (v: number) => void;
  route: MonitorRoute;
  onRouteChange: (r: MonitorRoute) => void;
  isRecording: boolean;
}

export default function MonitorSheet({
  visible,
  onClose,
  monitorOn,
  onMonitorToggle,
  volume,
  onVolumeChange,
  route,
  onRouteChange,
  isRecording,
}: MonitorSheetProps) {
  const colors = useColors();
  const isNative = Platform.OS !== "web";
  const [tested, setTested] = useState(false);
  const volStart = useRef(volume);

  // Stable PanResponder — created once, refs carry live values. (G24 pattern.)
  const volumeRef = useRef(volume);
  volumeRef.current = volume;
  const onVolumeChangeRef = useRef(onVolumeChange);
  onVolumeChangeRef.current = onVolumeChange;

  const volPan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: () => {
          volStart.current = volumeRef.current;
          Haptics.selectionAsync();
        },
        onPanResponderMove: (_, gs) => {
          const next = Math.max(0, Math.min(1, volStart.current + gs.dx / 240));
          onVolumeChangeRef.current(next);
        },
        onPanResponderRelease: () => Haptics.selectionAsync(),
        onPanResponderTerminate: () => Haptics.selectionAsync(),
      }),
    []
  );

  const runTest = async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setTested(false);
    try {
      await playMonitorTestTone();
      setTested(true);
    } catch {
      setTested(false);
    }
  };

  const handleToggleWithGuard = () => {
    if (!monitorOn && (route === "speaker" || route === "auto")) {
      Alert.alert(
        "Acoustic Feedback Risk",
        "Enabling monitor while routed to internal speakers can cause loud acoustic feedback loops into your microphone. We recommend using wired or Bluetooth headphones.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Enable Anyway",
            style: "destructive",
            onPress: () => onMonitorToggle(),
          },
        ]
      );
    } else {
      onMonitorToggle();
    }
  };

  const pct = Math.round(volume * 100);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.overlay}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        <Pressable style={styles.sheetWrap} onPress={() => {}}>
          {isNative && (
            <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
          )}
          <View style={[styles.sheet, { borderColor: "rgba(245,240,232,0.14)" }]}>
            <View style={[styles.handle, { backgroundColor: colors.muted }]} />

            <View style={styles.titleRow}>
              <Text style={[styles.title, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
                monitor
              </Text>
              {isRecording && monitorOn && (
                <Text style={[styles.warn, { fontFamily: font.thin, color: colors.accent }]}>
                  feedback risk — mind the mic
                </Text>
              )}
            </View>

            {/* Monitor out toggle */}
            <View style={[styles.row, { borderTopColor: colors.border }]}>
              <Ionicons
                name={monitorOn ? "headset" : "headset-outline"}
                size={17}
                color={monitorOn ? colors.primary : colors.mutedForeground}
              />
              <Text style={[styles.rowLabel, { fontFamily: font.thin, color: colors.foreground, letterSpacing: 2 }]}>
                monitor out
              </Text>
              <Switch
                value={monitorOn}
                onValueChange={handleToggleWithGuard}
                trackColor={{ false: colors.muted, true: colors.primary }}
                thumbColor={colors.foreground}
              />
            </View>

            {/* Volume */}
            <View style={styles.row}>
              <Ionicons
                name={volume === 0 ? "volume-mute-outline" : volume < 0.45 ? "volume-low-outline" : "volume-high-outline"}
                size={17}
                color={colors.mutedForeground}
              />
              <View style={styles.volWrap} {...volPan.panHandlers}>
                <View style={[styles.volTrack, { backgroundColor: colors.muted }]}>
                  <View style={[styles.volFill, { width: `${pct}%`, backgroundColor: colors.primary }]} />
                  <View style={[styles.volThumb, { left: `${pct}%`, backgroundColor: colors.primary }]} />
                </View>
              </View>
              <Text style={[styles.volPct, { fontFamily: font.mono, color: colors.mutedForeground }]}>
                {pct}%
              </Text>
            </View>

            {/* Route verification */}
            <View style={[styles.sectionLabelRow, { borderTopColor: colors.border }]}>
              <Text style={[styles.sectionLabel, { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide }]}>
                route · where you hear it
              </Text>
              <TouchableOpacity
                onPress={runTest}
                disabled={isRecording}
                style={[styles.testBtn, { borderColor: isRecording ? colors.border : colors.primary, opacity: isRecording ? 0.4 : 1 }]}
                accessibilityRole="button"
                accessibilityLabel="Play test tone"
              >
                <Ionicons name="play" size={12} color={colors.primary} />
                <Text style={[styles.testLabel, { fontFamily: font.thin, color: colors.primary, letterSpacing: 2 }]}>
                  test tone
                </Text>
              </TouchableOpacity>
            </View>
            {tested && (
              <Text style={[styles.tested, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                heard it? select the route above — it's saved as your monitor
              </Text>
            )}
            <View style={styles.routeGrid}>
              {ROUTES.filter((r) => r.id !== "earpiece" || Platform.OS === "android").map((r) => {
                const active = route === r.id;
                return (
                  <TouchableOpacity
                    key={r.id}
                    onPress={() => {
                      onRouteChange(r.id);
                      Haptics.selectionAsync();
                    }}
                    style={[
                      styles.routeChip,
                      {
                        borderColor: active ? colors.primary : colors.border,
                        backgroundColor: active ? `${colors.primary}18` : "transparent",
                      },
                    ]}
                    accessibilityRole="button"
                    accessibilityState={{ selected: active }}
                  >
                    <Ionicons
                      name={r.icon}
                      size={14}
                      color={active ? colors.primary : colors.mutedForeground}
                    />
                    <Text
                      style={[
                        styles.routeLabel,
                        {
                          fontFamily: font.thin,
                          color: active ? colors.primary : colors.mutedForeground,
                          letterSpacing: 1.5,
                        },
                      ]}
                    >
                      {r.label}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </View>
            {Platform.OS === "ios" && (
              <Text style={[styles.note, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                the physical route is set in control center — this records where your monitor lives
              </Text>
            )}

            {/* Done */}
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                onClose();
              }}
              style={[styles.done, { borderColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Close monitor settings"
            >
              <Text style={[styles.doneText, { fontFamily: font.thin, color: colors.primary, letterSpacing: tracking.wide }]}>
                done
              </Text>
            </TouchableOpacity>
          </View>
        </Pressable>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    justifyContent: "flex-end",
    backgroundColor: "rgba(10,13,20,0.5)",
  },
  sheetWrap: {
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    overflow: "hidden",
    backgroundColor: "rgba(18,24,36,0.92)",
  },
  sheet: {
    padding: 20,
    paddingBottom: 28,
    gap: 14,
    borderTopWidth: 1,
  },
  handle: {
    width: 36,
    height: 3,
    borderRadius: 2,
    alignSelf: "center",
    marginBottom: 2,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  title: { fontSize: 15 },
  warn: { fontSize: 10, letterSpacing: 0.4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  rowLabel: { fontSize: 13, flex: 1 },
  volWrap: { flex: 1, height: 26, justifyContent: "center" },
  volTrack: { height: 3, borderRadius: 2 },
  volFill: { position: "absolute", left: 0, top: 0, height: 3, borderRadius: 2 },
  volThumb: {
    position: "absolute",
    top: -5,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    marginLeft: -6.5,
  },
  volPct: { fontSize: 11, width: 40, textAlign: "right" },
  sectionLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  sectionLabel: { fontSize: 10 },
  testBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 5,
    paddingHorizontal: 12,
  },
  testLabel: { fontSize: 10 },
  tested: { fontSize: 10, marginTop: -6 },
  routeGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  routeChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingVertical: 7,
    paddingHorizontal: 12,
  },
  routeLabel: { fontSize: 11 },
  note: { fontSize: 9.5, lineHeight: 14 },
  done: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
    marginTop: 4,
  },
  doneText: { fontSize: 13 },
});
