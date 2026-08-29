import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  withRepeat,
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
  {
    n: "01",
    title: "Record",
    detail: "play till you find the loop",
  },
  {
    n: "02",
    title: "Layer",
    detail: "select the next loop layer by recording over the composition",
  },
  {
    n: "03",
    title: "Export",
    detail: "up to 5 layers of video and sound compile and save on your camera roll",
  },
];

function GlowOrb({
  color,
  size,
  animatedStyle,
}: {
  color: string;
  size: number;
  animatedStyle?: any;
}) {
  const rings = [
    { f: 1.0, o: 0.05 },
    { f: 0.64, o: 0.09 },
    { f: 0.36, o: 0.16 },
  ];
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ width: size, height: size }, animatedStyle]}
    >
      {rings.map((ring, i) => {
        const d = size * ring.f;
        const inset = (size - d) / 2;
        return (
          <View
            key={i}
            style={{
              position: "absolute",
              top: inset,
              left: inset,
              width: d,
              height: d,
              borderRadius: d / 2,
              backgroundColor: color,
              opacity: ring.o,
            }}
          />
        );
      })}
    </Animated.View>
  );
}

export default function EntranceScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const reducedMotion = useReducedMotion();
  const isNative = Platform.OS !== "web";
  const {
    loops,
    savedSessions,
    saveCurrentToSessions,
    loadSession,
    clearAll,
    monitorOn,
    setMonitorOn,
  } = useLoops();

  const [selectedRatio] = useState<RatioKind>("9:16");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);

  const leaving = useRef(false);
  const contentOpacity = useSharedValue(1);
  const wordmarkOpacity = useSharedValue(0);
  const stepsOpacity = useSharedValue(0);
  const actionsOpacity = useSharedValue(0);
  const stepsY = useSharedValue(14);
  const actionsY = useSharedValue(16);
  const orbGoldX = useSharedValue(0);
  const orbGoldY = useSharedValue(0);
  const orbIndigoX = useSharedValue(0);
  const orbIndigoY = useSharedValue(0);

  useEffect(() => {
    if (reducedMotion) {
      wordmarkOpacity.value = 1;
      stepsOpacity.value = 1;
      actionsOpacity.value = 1;
      stepsY.value = 0;
      actionsY.value = 0;
      return;
    }
    // The intro instructions fade in and stay — they leave only when the
    // user picks an option and the screen fades to the next frame.
    wordmarkOpacity.value = withTiming(1, { duration: 900 });
    stepsOpacity.value = withDelay(450, withTiming(1, { duration: 900 }));
    stepsY.value = withDelay(450, withTiming(0, { duration: 900 }));
    actionsOpacity.value = withDelay(1100, withTiming(1, { duration: 800 }));
    actionsY.value = withDelay(1100, withTiming(0, { duration: 800 }));
  }, [
    reducedMotion,
    wordmarkOpacity,
    stepsOpacity,
    actionsOpacity,
    stepsY,
    actionsY,
  ]);

  useEffect(() => {
    if (reducedMotion) return;
    orbGoldX.value = withRepeat(withTiming(1, { duration: 11000 }), -1, true);
    orbGoldY.value = withRepeat(withTiming(1, { duration: 15000 }), -1, true);
    orbIndigoX.value = withRepeat(withTiming(1, { duration: 16000 }), -1, true);
    orbIndigoY.value = withRepeat(withTiming(1, { duration: 12000 }), -1, true);
  }, [reducedMotion, orbGoldX, orbGoldY, orbIndigoX, orbIndigoY]);

  const wordmarkStyle = useAnimatedStyle(() => ({
    opacity: wordmarkOpacity.value,
  }));
  const stepsStyle = useAnimatedStyle(() => ({
    opacity: stepsOpacity.value,
    transform: [{ translateY: stepsY.value }],
  }));
  const actionsStyle = useAnimatedStyle(() => ({
    opacity: actionsOpacity.value,
    transform: [{ translateY: actionsY.value }],
  }));
  const contentStyle = useAnimatedStyle(() => ({
    opacity: contentOpacity.value,
  }));
  const orbGoldStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: orbGoldX.value * 46 - 23 },
      { translateY: orbGoldY.value * 56 - 28 },
    ],
  }));
  const orbIndigoStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: orbIndigoX.value * 60 - 30 },
      { translateY: orbIndigoY.value * 48 - 24 },
    ],
  }));

  const topPad = Platform.OS === "web" ? 40 : insets.top;
  const bottomPad = Platform.OS === "web" ? 24 : insets.bottom + 24;

  // Re-arm the entrance whenever the user returns to it — the leave fade
  // sets leaving + opacity, and both must reset or the screen becomes an
  // invisible dead end (new loop / saved do nothing).
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
    // Fade the whole entrance to the next frame, then hand off to camera.
    contentOpacity.value = withTiming(0, { duration: 380 }, () => {
      router.push({ pathname: "/camera", params: { ratio: selectedRatio } });
    });
  };

  const goToCamera = () => {
    if (leaving.current) return;
    leaving.current = true;
    if (__DEV__) console.log("[entrance] new loop pressed — navigating to /camera");
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    // A fresh project never carries the previous one along: stash it into
    // saved sessions first, then clear and open a blank loop.
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
      Alert.alert(
        "Session Unavailable",
        "The recordings for this session are no longer on this device."
      );
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
    <View style={[styles.root, { backgroundColor: colors.background }]}>
      <StatusBar barStyle="light-content" />

      {/* Smooth gradient base */}
      <LinearGradient
        colors={["#0A0D14", "#111A2E", "#0A0F1E"]}
        locations={[0, 0.52, 1]}
        start={{ x: 0.15, y: 0 }}
        end={{ x: 0.85, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {/* Gold sheen falling from the top */}
      <LinearGradient
        colors={["rgba(212,168,75,0.13)", "rgba(212,168,75,0)"]}
        start={{ x: 0.5, y: 0 }}
        end={{ x: 0.5, y: 0.5 }}
        style={StyleSheet.absoluteFill}
      />

      {/* Drifting glow orbs */}
      <GlowOrb
        color="#D4A84B"
        size={440}
        animatedStyle={[styles.orbGold, orbGoldStyle]}
      />
      <GlowOrb
        color="#4A538A"
        size={540}
        animatedStyle={[styles.orbIndigo, orbIndigoStyle]}
      />
      <GlowOrb color="#B85C42" size={300} animatedStyle={styles.orbSienna} />

      {/* Settings cog — top right */}
      <TouchableOpacity
        onPress={() => {
          Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          setSettingsOpen(true);
        }}
        style={[styles.settingsBtn, { top: topPad + 18 }]}
        accessibilityRole="button"
        accessibilityLabel="Open settings"
      >
        <Ionicons name="settings-outline" size={20} color={colors.foreground} />
      </TouchableOpacity>

      {/* Settings modal */}
      <Modal
        visible={settingsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSettingsOpen(false)}
      >
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsCard}>
            {isNative && (
              <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
            )}
            <Text
              style={[
                styles.settingsTitle,
                { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide },
              ]}
            >
              settings
            </Text>
            <View style={styles.settingsRow}>
              <Text
                style={[
                  styles.settingsLabel,
                  { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: 2 },
                ]}
              >
                monitor
              </Text>
              <Switch
                value={monitorOn}
                onValueChange={setMonitorOn}
                trackColor={{ false: colors.muted, true: colors.primary }}
                thumbColor={colors.foreground}
              />
            </View>
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSettingsOpen(false);
              }}
              style={[styles.settingsDone, { borderColor: colors.primary }]}
              accessibilityRole="button"
              accessibilityLabel="Close settings"
            >
              <Text
                style={[
                  styles.settingsDoneText,
                  { fontFamily: font.thin, color: colors.primary, letterSpacing: tracking.wide },
                ]}
              >
                done
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* Saved sessions modal */}
      <Modal
        visible={sessionsOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setSessionsOpen(false)}
      >
        <View style={styles.settingsOverlay}>
          <View style={styles.settingsCard}>
            {isNative && (
              <BlurView intensity={50} tint="dark" style={StyleSheet.absoluteFill} />
            )}
            <Text
              style={[
                styles.settingsTitle,
                { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide },
              ]}
            >
              saved sessions
            </Text>
            {Platform.OS === "web" && (
              <Text style={[styles.sessionsEmpty, { fontFamily: font.light, color: colors.mutedForeground, marginTop: -4 }]}>
                sessions don't survive page reload on web — export your project for durable storage
              </Text>
            )}
            {loops.length > 0 && (
              <TouchableOpacity
                onPress={() => {
                  setSessionsOpen(false);
                  if (!leaving.current) {
                    leaving.current = true;
                    navigateToCamera();
                  }
                }}
                style={[styles.sessionRow, { borderColor: colors.primary }]}
                accessibilityRole="button"
                accessibilityLabel="Continue current session"
              >
                <View style={styles.sessionMeta}>
                  <Text style={[styles.sessionTitle, { fontFamily: font.light, color: colors.primary }]}>
                    current session
                  </Text>
                  <Text style={[styles.sessionSub, { fontFamily: font.light, color: colors.mutedForeground }]}>
                    {loops.length} layer{loops.length !== 1 ? "s" : ""} · open now
                  </Text>
                </View>
                <Ionicons name="arrow-forward" size={16} color={colors.primary} />
              </TouchableOpacity>
            )}
            {savedSessions.length === 0 ? (
              <Text style={[styles.sessionsEmpty, { fontFamily: font.light, color: colors.mutedForeground }]}>
                no saved sessions yet — start a new loop and it will be kept here automatically
              </Text>
            ) : (
              <ScrollView style={styles.sessionsListScroll} bounces={false}>
                <View style={styles.sessionsList}>
                {savedSessions.map((s) => {
                  // Session integrity badge — grey out dead sessions. (G16 fix.)
                  const isDead = Platform.OS !== "web"
                    ? s.loops.some((l) => {
                        try {
                          const f = new (require("expo-file-system").File)(l.videoUri);
                          return !f.exists;
                        } catch {
                          return true;
                        }
                      })
                    : s.loops.some((l) => l.videoUri.startsWith("blob:"));
                  return (
                  <TouchableOpacity
                    key={s.id}
                    onPress={() => openSession(s)}
                    style={[styles.sessionRow, { borderColor: isDead ? `${colors.mutedForeground}44` : colors.border, opacity: isDead ? 0.5 : 1 }]}
                    accessibilityRole="button"
                    accessibilityLabel={`Open session with ${s.layerCount} layers${isDead ? " — files missing" : ""}`}
                  >
                    <View style={styles.sessionMeta}>
                      <Text style={[styles.sessionTitle, { fontFamily: font.light, color: colors.foreground }]}>
                        {s.layerCount} layer{s.layerCount !== 1 ? "s" : ""}
                        {s.masterDuration > 0 ? ` · ${formatClock(s.masterDuration)}` : ""}
                      </Text>
                      <Text style={[styles.sessionSub, { fontFamily: font.light, color: isDead ? colors.accent : colors.mutedForeground }]}>
                        {isDead ? "files missing · " : ""}saved {formatWhen(s.savedAt)}
                      </Text>
                    </View>
                    <Ionicons name="chevron-forward" size={16} color={colors.mutedForeground} />
                  </TouchableOpacity>
                  );
                })}
                </View>
              </ScrollView>
            )}
            <TouchableOpacity
              onPress={() => {
                Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setSessionsOpen(false);
              }}
              style={[styles.settingsDone, { borderColor: colors.border }]}
              accessibilityRole="button"
              accessibilityLabel="Close saved sessions"
            >
              <Text
                style={[
                  styles.settingsDoneText,
                  { fontFamily: font.thin, color: colors.mutedForeground, letterSpacing: tracking.wide },
                ]}
              >
                done
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Animated.View
        style={[
          styles.content,
          { paddingTop: topPad + 32, paddingBottom: bottomPad },
          contentStyle,
        ]}
      >
        {/* Wordmark */}
        <Animated.View style={[styles.wordmarkBlock, wordmarkStyle]}>
          <Text
            style={[
              styles.wordmark,
              {
                fontFamily: font.thin,
                color: colors.foreground,
                letterSpacing: 8,
              },
            ]}
          >
            LOOPLAYER
          </Text>
          <LinearGradient
            colors={[
              "rgba(212,168,75,0)",
              "rgba(212,168,75,0.9)",
              "rgba(212,168,75,0)",
            ]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0 }}
            style={styles.wordmarkRule}
          />
        </Animated.View>

        <View style={styles.spacer} />

        {/* Intro instructions — static column, fades in and stays until a choice is made */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.glassCard,
            {
              backgroundColor: isNative
                ? "rgba(18,24,36,0.30)"
                : "rgba(18,24,36,0.55)",
            },
            stepsStyle,
          ]}
        >
          {isNative && (
            <BlurView intensity={48} tint="dark" style={StyleSheet.absoluteFill} />
          )}
          <LinearGradient
            colors={["rgba(245,240,232,0.12)", "rgba(245,240,232,0)"]}
            start={{ x: 0.5, y: 0 }}
            end={{ x: 0.5, y: 0.5 }}
            pointerEvents="none"
            style={styles.cardSheen}
          />
          <Text
            style={[
              styles.eyebrow,
              { color: colors.mutedForeground, fontFamily: font.light },
            ]}
          >
            GETTING STARTED
          </Text>
          <View style={styles.stepsColumn}>
            {INTRO_STEPS.map((step, i) => (
              <View key={step.n}>
                {i > 0 && <View style={styles.stepDivider} />}
                <View style={styles.stepRow}>
                  <Text
                    style={[
                      styles.stepNum,
                      { color: colors.primary, fontFamily: font.mono },
                    ]}
                  >
                    {step.n}
                  </Text>
                  <View style={styles.stepBody}>
                    <Text
                      style={[
                        styles.stepTitle,
                        {
                          color: colors.foreground,
                          fontFamily: font.light,
                          letterSpacing: tracking.wide,
                        },
                      ]}
                    >
                      {step.title}
                    </Text>
                    <Text
                      style={[
                        styles.stepDetail,
                        {
                          color: colors.mutedForeground,
                          fontFamily: font.light,
                        },
                      ]}
                    >
                      {step.detail}
                    </Text>
                  </View>
                </View>
              </View>
            ))}
          </View>
        </Animated.View>

        <View style={styles.spacer} />

        {/* Button column — both options stay visible beneath the steps */}
        <Animated.View style={[styles.buttonColumn, actionsStyle]}>
          <TouchableOpacity
            onPress={goToCamera}
            style={styles.mainBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Create a new loop"
          >
            <LinearGradient
              colors={["#E6C166", "#C99B3E"]}
              start={{ x: 0, y: 0 }}
              end={{ x: 1, y: 1 }}
              style={StyleSheet.absoluteFill}
            />
            <Ionicons
              name="add-circle-outline"
              size={22}
              color={colors.primaryForeground}
            />
            <Text
              style={[
                styles.mainBtnText,
                {
                  fontFamily: font.thin,
                  color: colors.primaryForeground,
                  letterSpacing: tracking.wide,
                },
              ]}
            >
              new loop
            </Text>
          </TouchableOpacity>

          <TouchableOpacity
            onPress={() => {
              Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setSessionsOpen(true);
            }}
            style={styles.secBtn}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="Open saved sessions"
          >
            {isNative && (
              <BlurView intensity={28} tint="dark" style={StyleSheet.absoluteFill} />
            )}
            <Ionicons
              name="albums-outline"
              size={18}
              color={colors.mutedForeground}
            />
            <Text
              style={[
                styles.secBtnText,
                { fontFamily: font.thin, color: colors.mutedForeground },
              ]}
            >
              saved
            </Text>
          </TouchableOpacity>
        </Animated.View>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: "hidden",
  },
  settingsBtn: {
    position: "absolute",
    right: 24,
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.14)",
    backgroundColor: "rgba(245,240,232,0.05)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 30,
  },
  settingsOverlay: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10,13,20,0.55)",
    padding: 32,
  },
  settingsCard: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.14)",
    backgroundColor: "rgba(18,24,36,0.85)",
    overflow: "hidden",
    padding: 22,
    gap: 18,
  },
  settingsTitle: {
    fontSize: 15,
    textAlign: "center",
  },
  settingsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  settingsLabel: {
    fontSize: 13,
    textTransform: "lowercase",
  },
  settingsDone: {
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 12,
    alignItems: "center",
  },
  settingsDoneText: {
    fontSize: 13,
  },
  sessionsList: {
    gap: 8,
  },
  sessionsListScroll: {
    maxHeight: 320,
  },
  sessionRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    backgroundColor: "rgba(245,240,232,0.04)",
  },
  sessionMeta: {
    flex: 1,
    gap: 2,
    paddingRight: 10,
  },
  sessionTitle: {
    fontSize: 14,
    letterSpacing: 1,
  },
  sessionSub: {
    fontSize: 12,
  },
  sessionsEmpty: {
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingVertical: 18,
    paddingHorizontal: 10,
  },
  content: {
    flex: 1,
    alignItems: "center",
    paddingHorizontal: 32,
  },

  wordmarkBlock: {
    alignItems: "center",
  },
  wordmark: {
    fontSize: 16,
    letterSpacing: 8,
  },
  wordmarkRule: {
    width: 92,
    height: 1.5,
    borderRadius: 1,
    marginTop: 14,
  },

  spacer: {
    flex: 1,
  },

  glassCard: {
    width: "100%",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.12)",
    overflow: "hidden",
    paddingVertical: 22,
    paddingHorizontal: 24,
  },
  cardSheen: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 56,
  },
  eyebrow: {
    fontSize: 10,
    letterSpacing: 3,
    textAlign: "center",
    marginBottom: 10,
  },
  stepsColumn: {
    gap: 0,
  },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 16,
    paddingVertical: 12,
  },
  stepNum: {
    fontSize: 13,
    letterSpacing: 2,
    width: 30,
    paddingTop: 3,
    opacity: 0.9,
  },
  stepBody: {
    flex: 1,
  },
  stepTitle: {
    fontSize: 16,
    letterSpacing: 3,
    textTransform: "uppercase",
    marginBottom: 4,
  },
  stepDetail: {
    fontSize: 12,
    lineHeight: 17,
    letterSpacing: 0.3,
  },
  stepDivider: {
    height: 1,
    backgroundColor: "rgba(245,240,232,0.08)",
    marginLeft: 46,
  },

  orbGold: {
    position: "absolute",
    top: -140,
    right: -120,
  },
  orbIndigo: {
    position: "absolute",
    bottom: -190,
    left: -170,
  },
  orbSienna: {
    position: "absolute",
    top: "36%",
    left: -110,
  },

  buttonColumn: {
    width: "100%",
    gap: 12,
  },
  mainBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
    paddingVertical: 18,
    borderRadius: 18,
    overflow: "hidden",
  },
  mainBtnText: {
    fontSize: 16,
    letterSpacing: 3,
  },
  secBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(245,240,232,0.14)",
    backgroundColor: "rgba(245,240,232,0.05)",
    overflow: "hidden",
  },
  secBtnText: {
    fontSize: 14,
    letterSpacing: 2,
  },
});
