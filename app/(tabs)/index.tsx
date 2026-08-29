import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  Modal,
  Platform,
  ScrollView,
  StatusBar,
  StyleSheet,
  Switch,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withTiming,
} from "react-native-reanimated";
import { Ionicons } from "@expo/vector-icons";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";
import { router, useFocusEffect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";

import { useColors } from "@/hooks/useColors";
import { useLoops, type SavedSession } from "@/context/LoopContext";
import { font, tracking } from "@/constants/typography";

type RatioKind = "1:1" | "4:5" | "9:16";

const INTRO_STEPS = [
  { n: "01", title: "Record", detail: "play till you find the loop", accent: "#a78bfa" },
  { n: "02", title: "Layer", detail: "select the next loop layer by recording over the composition", accent: "#22d3ee" },
  { n: "03", title: "Export", detail: "up to 5 layers of video and sound compile and save on your camera roll", accent: "#fb7185" },
];

export default function EntranceScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const isNative = Platform.OS !== "web";
  const {
    loops, savedSessions, saveCurrentToSessions, loadSession,
    clearAll, monitorOn, setMonitorOn,
  } = useLoops();

  const [selectedRatio] = useState<RatioKind>("9:16");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const leaving = useRef(false);
  const contentOpacity = useSharedValue(1);
  const titleOpacity = useSharedValue(0);
  const stepsOpacity = useSharedValue(0);
  const actionsOpacity = useSharedValue(0);
  const stepsY = useSharedValue(12);
  const actionsY = useSharedValue(14);

  useEffect(() => {
    if (reducedMotion) {
      titleOpacity.value = 1;
      stepsOpacity.value = 1;
      actionsOpacity.value = 1;
      stepsY.value = 0;
      actionsY.value = 0;
      return;
    }
    titleOpacity.value = withTiming(1, { duration: 1200 });
    stepsOpacity.value = withDelay(600, withTiming(1, { duration: 1000 }));
    stepsY.value = withDelay(600, withTiming(0, { duration: 1000 }));
    actionsOpacity.value = withDelay(1400, withTiming(1, { duration: 800 }));
    actionsY.value = withDelay(1400, withTiming(0, { duration: 800 }));
  }, [reducedMotion, titleOpacity, stepsOpacity, actionsOpacity, stepsY, actionsY]);

  const titleStyle = useAnimatedStyle(() => ({ opacity: titleOpacity.value }));
  const stepsStyle = useAnimatedStyle(() => ({
    opacity: stepsOpacity.value,
    transform: [{ translateY: stepsY.value }],
  }));
  const actionsStyle = useAnimatedStyle(() => ({
    opacity: actionsOpacity.value,
    transform: [{ translateY: actionsY.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({ opacity: contentOpacity.value }));

  const topPad = Platform.OS === "web" ? 40 : insets.top;
  const bottomPad = Platform.OS === "web" ? 24 : insets.bottom + 24;

  useFocusEffect(
    useCallback(() => {
      leaving.current = false;
      contentOpacity.value = 1;
      return () => {};
    }, [contentOpacity])
  );

  const navigateToCamera = () => {
    if (reducedMotion) {
      router.push({ pathname: "/camera", params: { ratio: selectedRatio } });
      return;
    }
    contentOpacity.value = withTiming(0, { duration: 320 }, () => {
      router.push({ pathname: "/camera", params: { ratio: selectedRatio } });
    });
  };

  const goToCamera = () => {
    if (leaving.current) return;
    leaving.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (loops.length > 0) {
      saveCurrentToSessions();
      clearAll();
    }
    navigateToCamera();
  };

  const openSession = (session: SavedSession) => {
    if (leaving.current) return;
    setSessionsOpen(false);
    const ok = loadSession(session);
    if (!ok) {
      Alert.alert("Session Unavailable", "The recordings for this session are no longer on this device.");
      return;
    }
    leaving.current = true;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    navigateToCamera();
  };

  const formatClock = (ms: number) => {
    const s = Math.round(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const formatWhen = (ts: number) => {
    const d = new Date(ts);
    return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} · ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
  };

  return (
    <View style={[styles.root, { backgroundColor: "#060d06" }]}>
      <StatusBar barStyle="light-content" />

      {/* Settings button — glass circle */}
      <TouchableOpacity
        onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSettingsOpen(true); }}
        style={[styles.settingsBtn, { top: topPad + 18 }]}
        accessibilityRole="button"
        accessibilityLabel="Open settings"
      >
        <Ionicons name="settings-outline" size={17} color="rgba(255,255,255,0.5)" />
      </TouchableOpacity>

      {/* Settings modal */}
      <Modal visible={settingsOpen} transparent animationType="fade" onRequestClose={() => setSettingsOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.glassModal}>
            {isNative && <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />}
            <LinearGradient
              colors={["rgba(255,255,255,0.06)", "rgba(255,255,255,0)"]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 0.4 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <Text style={[styles.modalTitle, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)", letterSpacing: tracking.wide }]}>
              settings
            </Text>
            <View style={styles.settingsRow}>
              <Text style={[styles.settingsLabel, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>
                monitor
              </Text>
              <Switch
                value={monitorOn}
                onValueChange={setMonitorOn}
                trackColor={{ false: "rgba(255,255,255,0.06)", true: "#a78bfa" }}
                thumbColor="rgba(255,255,255,0.92)"
              />
            </View>
            <TouchableOpacity
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSettingsOpen(false); }}
              style={[styles.doneBtn, { borderColor: "rgba(255,255,255,0.08)" }]}
              accessibilityRole="button"
            >
              <Text style={[styles.doneBtnText, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)", letterSpacing: tracking.wide }]}>
                done
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Saved sessions modal */}
      <Modal visible={sessionsOpen} transparent animationType="fade" onRequestClose={() => setSessionsOpen(false)}>
        <View style={styles.overlay}>
          <View style={styles.glassModal}>
            {isNative && <BlurView intensity={40} tint="dark" style={StyleSheet.absoluteFill} />}
            <LinearGradient
              colors={["rgba(255,255,255,0.06)", "rgba(255,255,255,0)"]}
              start={{ x: 0.5, y: 0 }}
              end={{ x: 0.5, y: 0.4 }}
              style={StyleSheet.absoluteFill}
              pointerEvents="none"
            />
            <Text style={[styles.modalTitle, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)", letterSpacing: tracking.wide }]}>
              saved sessions
            </Text>
            {loops.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setSessionsOpen(false);
                  if (!leaving.current) { leaving.current = true; navigateToCamera(); }
                }}
                style={[styles.sessionRow, { borderColor: "rgba(167,139,250,0.3)" }]}
                accessibilityRole="button"
              >
                <View style={styles.sessionMeta}>
                  <Text style={[styles.sessionTitle, { fontFamily: font.light, color: "#a78bfa" }]}>
                    current session
                  </Text>
                  <Text style={[styles.sessionSub, { fontFamily: font.light, color: "rgba(255,255,255,0.5)" }]}>
                    {loops.length} layer{loops.length !== 1 ? "s" : ""} · open now
                  </Text>
                </View>
                <Ionicons name="arrow-forward" size={14} color="#a78bfa" />
              </TouchableOpacity>
            )}
            {savedSessions.length === 0 ? (
              <Text style={[styles.sessionsEmpty, { fontFamily: font.light, color: "rgba(255,255,255,0.5)" }]}>
                no saved sessions yet
              </Text>
            ) : (
              <ScrollView style={styles.sessionsScroll} bounces={false}>
                <View style={styles.sessionsList}>
                  {savedSessions.map((s) => (
                    <TouchableOpacity
                      key={s.id}
                      onPress={() => openSession(s)}
                      style={[styles.sessionRow, { borderColor: "rgba(255,255,255,0.06)" }]}
                      accessibilityRole="button"
                    >
                      <View style={styles.sessionMeta}>
                        <Text style={[styles.sessionTitle, { fontFamily: font.light, color: "rgba(255,255,255,0.92)" }]}>
                          {s.layerCount} layer{s.layerCount !== 1 ? "s" : ""}
                          {s.masterDuration > 0 ? ` · ${formatClock(s.masterDuration)}` : ""}
                        </Text>
                        <Text style={[styles.sessionSub, { fontFamily: font.light, color: "rgba(255,255,255,0.5)" }]}>
                          saved {formatWhen(s.savedAt)}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={14} color="rgba(255,255,255,0.3)" />
                    </TouchableOpacity>
                  ))}
                </View>
              </ScrollView>
            )}
            <TouchableOpacity
              onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSessionsOpen(false); }}
              style={[styles.doneBtn, { borderColor: "rgba(255,255,255,0.06)" }]}
              accessibilityRole="button"
            >
              <Text style={[styles.doneBtnText, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)", letterSpacing: tracking.wide }]}>
                done
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Animated.View style={[styles.content, { paddingTop: topPad + 48, paddingBottom: bottomPad }, contentStyle]}>
        {/* Title — glassmorphic brand */}
        <Animated.View style={[styles.titleBlock, titleStyle]}>
          <View style={styles.brandIcon}>
            <Text style={{ fontSize: 18, color: "#a78bfa" }}>◈</Text>
          </View>
          <Text style={[styles.title, { fontFamily: font.thin, color: "rgba(255,255,255,0.92)", letterSpacing: 10 }]}>
            AESTHETIC
          </Text>
          <Text style={[styles.subtitle, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>
            loop · layer · compose
          </Text>
        </Animated.View>

        <View style={styles.spacer} />

        {/* Steps — glass bento cells */}
        <Animated.View style={[styles.stepsCard, stepsStyle]}>
          {isNative && <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />}
          <LinearGradient
            colors={["rgba(255,255,255,0.06)", "rgba(255,255,255,0)"]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 0.5 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <Text style={[styles.eyebrow, { color: "rgba(255,255,255,0.5)", fontFamily: font.thin }]}>
            HOW IT WORKS
          </Text>
          <View style={styles.stepsColumn}>
            {INTRO_STEPS.map((step, i) => (
              <View key={step.n}>
                {i > 0 && <View style={[styles.stepDivider, { backgroundColor: "rgba(255,255,255,0.06)" }]} />}
                <View style={styles.stepRow}>
                  <View style={[styles.stepNumBadge, { backgroundColor: `${step.accent}15` }]}>
                    <Text style={[styles.stepNum, { color: step.accent, fontFamily: font.mono }]}>
                      {step.n}
                    </Text>
                  </View>
                  <View style={styles.stepBody}>
                    <Text style={[styles.stepTitle, { color: "rgba(255,255,255,0.92)", fontFamily: font.light, letterSpacing: tracking.wide }]}>
                      {step.title}
                    </Text>
                    <Text style={[styles.stepDetail, { color: "rgba(255,255,255,0.5)", fontFamily: font.light }]}>
                      {step.detail}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>

        <View style={styles.spacer} />

        {/* Actions — glass buttons */}
        <Animated.View style={[styles.buttonColumn, actionsStyle]}>
          <TouchableOpacity
            onPress={goToCamera}
            style={styles.primaryBtn}
            activeOpacity={0.88}
            accessibilityRole="button"
            accessibilityLabel="Create a new loop"
          >
            <LinearGradient
              colors={["#a78bfa", "#8b5cf6"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Ionicons name="add-circle-outline" size={20} color="#060d06" />
            <Text style={[styles.primaryBtnText, { fontFamily: font.demi, color: "#060d06", letterSpacing: tracking.wide }]}>
              new loop
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); setSessionsOpen(true); }}
            style={styles.secondaryBtn}
            activeOpacity={0.88}
            accessibilityRole="button"
            accessibilityLabel="Open saved sessions"
          >
            {isNative && <BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} />}
            <Ionicons name="albums-outline" size={16} color="rgba(255,255,255,0.5)" />
            <Text style={[styles.secondaryBtnText, { fontFamily: font.thin, color: "rgba(255,255,255,0.5)" }]}>
              saved
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  settingsBtn: {
    position: "absolute", right: 24,
    width: 40, height: 40, borderRadius: 14,
    backgroundColor: "rgba(255,255,255,0.035)",
    alignItems: "center", justifyContent: "center", zIndex: 30,
    shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
  },
  overlay: {
    flex: 1, alignItems: "center", justifyContent: "center",
    backgroundColor: "rgba(6,13,6,0.82)", padding: 32,
  },
  glassModal: {
    width: "100%", borderRadius: 20,
    overflow: "hidden", padding: 24, gap: 20,
    backgroundColor: "rgba(255,255,255,0.035)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.4, shadowRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
  },
  modalTitle: { fontSize: 14, textAlign: "center" },
  settingsRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
  },
  settingsLabel: { fontSize: 13, letterSpacing: 1.5, textTransform: "lowercase" },
  doneBtn: {
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 14, paddingVertical: 12, alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.035)",
  },
  doneBtnText: { fontSize: 13 },
  sessionsList: { gap: 8 },
  sessionsScroll: { maxHeight: 320 },
  sessionRow: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12,
    backgroundColor: "rgba(255,255,255,0.025)",
  },
  sessionMeta: { flex: 1, gap: 2, paddingRight: 10 },
  sessionTitle: { fontSize: 14, letterSpacing: 0.8 },
  sessionSub: { fontSize: 12 },
  sessionsEmpty: { fontSize: 13, lineHeight: 19, textAlign: "center", paddingVertical: 18 },
  content: { flex: 1, alignItems: "center", paddingHorizontal: 32 },
  titleBlock: { alignItems: "center", gap: 10 },
  brandIcon: {
    width: 44, height: 44, borderRadius: 16,
    backgroundColor: "rgba(167,139,250,0.12)",
    alignItems: "center", justifyContent: "center",
    shadowColor: "#a78bfa", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.25, shadowRadius: 32,
  },
  title: { fontSize: 16 },
  subtitle: { fontSize: 12, letterSpacing: 1.5 },
  spacer: { flex: 1 },
  stepsCard: {
    width: "100%", borderRadius: 20,
    paddingVertical: 24, paddingHorizontal: 24,
    backgroundColor: "rgba(255,255,255,0.035)",
    shadowColor: "#000", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
  },
  eyebrow: { fontSize: 9, letterSpacing: 3, textAlign: "center", marginBottom: 14 },
  stepsColumn: {},
  stepRow: { flexDirection: "row", alignItems: "flex-start", gap: 14, paddingVertical: 14 },
  stepNumBadge: {
    width: 30, height: 30, borderRadius: 10,
    alignItems: "center", justifyContent: "center",
  },
  stepNum: { fontSize: 11, letterSpacing: 1 },
  stepBody: { flex: 1 },
  stepTitle: { fontSize: 15, letterSpacing: 2.5, textTransform: "uppercase", marginBottom: 4 },
  stepDetail: { fontSize: 12, lineHeight: 17, letterSpacing: 0.3 },
  stepDivider: { height: StyleSheet.hairlineWidth, marginLeft: 44 },
  buttonColumn: { width: "100%", gap: 12 },
  primaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 10, paddingVertical: 18, borderRadius: 16,
    overflow: "hidden",
    shadowColor: "#a78bfa", shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 24,
  },
  primaryBtnText: { fontSize: 15, letterSpacing: 2.5 },
  secondaryBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center",
    gap: 8, paddingVertical: 14, borderRadius: 16,
    backgroundColor: "rgba(255,255,255,0.035)",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.06)",
    overflow: "hidden",
    shadowColor: "#000", shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 16,
  },
  secondaryBtnText: { fontSize: 14, letterSpacing: 1.5 },
});
