/**
 * ExportPanel — bottom sheet that materializes every layer's loop phrase as a
 * video clip (web: true trimmed re-record; native: full-take copy + share).
 * Each finished clip is saved/shared with a direct user gesture so browser
 * multi-download guards never swallow a file.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useColors } from "@/hooks/useColors";
import { font, tracking } from "@/constants/typography";
import {
  exportAllClips,
  exportCompositeOnWeb,
  type CompositeClip,
  type ExportedClip,
} from "@/utils/export-clips";
import type { Loop } from "@/context/LoopContext";
import { useLoops } from "@/context/LoopContext";

interface ExportPanelProps {
  visible: boolean;
  loops: Loop[];
  onClose: () => void;
}

function fmt(ms: number) {
  return `${Math.round(ms / 1000)}s`;
}

export default function ExportPanel({ visible, loops, onClose }: ExportPanelProps) {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { masterDuration } = useLoops();

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [clips, setClips] = useState<ExportedClip[]>([]);
  const [errors, setErrors] = useState<Record<number, string>>({});

  const [composite, setComposite] = useState<CompositeClip | null>(null);
  const [compositeRunning, setCompositeRunning] = useState(false);
  const [compositeError, setCompositeError] = useState<string | null>(null);

  const clipsRef = useRef<ExportedClip[]>([]);
  clipsRef.current = clips;
  const compositeRef = useRef<CompositeClip | null>(null);
  compositeRef.current = composite;
  // Stale closure fix (G39): read loops from a ref updated per render.
  const loopsRef = useRef(loops);
  loopsRef.current = loops;

  // Fresh state each time the sheet opens
  useEffect(() => {
    if (visible) {
      setRunning(false);
      setProgress({ done: 0, total: 0 });
      // Revoke previous clips' blob URLs before clearing. (G41 fix.)
      clipsRef.current.forEach((c) => {
        if (c.uri.startsWith("blob:")) URL.revokeObjectURL(c.uri);
      });
      setClips([]);
      setErrors({});
      setCompositeRunning(false);
      setCompositeError(null);
    }
  }, [visible]);

  // Release exported blob URLs when the sheet closes
  useEffect(() => {
    if (!visible) {
      clipsRef.current.forEach((c) => {
        if (c.uri.startsWith("blob:")) URL.revokeObjectURL(c.uri);
      });
      setClips([]);
      if (compositeRef.current?.uri.startsWith("blob:")) {
        URL.revokeObjectURL(compositeRef.current.uri);
      }
      setComposite(null);
    }
  }, [visible]);

  const ordered = [...loops].sort((a, b) => a.layerIndex - b.layerIndex);

  const handleCompositeExport = useCallback(async () => {
    const currentLoops = loopsRef.current;
    if (compositeRunning || currentLoops.length === 0) return;
    if (Platform.OS !== "web") {
      setCompositeError("Composite video is exported by the web build.");
      return;
    }
    if (!masterDuration) {
      setCompositeError("Record a loop first — the master tempo is unset.");
      return;
    }
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCompositeRunning(true);
    setCompositeError(null);
    setComposite(null);
    try {
      const result = await exportCompositeOnWeb(currentLoops, masterDuration);
      setComposite(result);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setCompositeError(e instanceof Error ? e.message : "Composite export failed unexpectedly.");
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCompositeRunning(false);
    }
  }, [compositeRunning, masterDuration]);

  const handleSaveComposite = (clip: CompositeClip) => {
    Haptics.selectionAsync();
    const anchor = document.createElement("a");
    anchor.href = clip.uri;
    anchor.download = clip.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleExportAll = useCallback(async () => {
    const currentLoops = loopsRef.current;
    if (running || currentLoops.length === 0) return;
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setRunning(true);
    setErrors({});
    // Revoke previous clips before clearing. (G41 fix.)
    clipsRef.current.forEach((c) => {
      if (c.uri.startsWith("blob:")) URL.revokeObjectURL(c.uri);
    });
    setClips([]);
    try {
      const result = await exportAllClips(currentLoops, (done, total) =>
        setProgress({ done, total })
      );
      setClips(result);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setErrors({
        "-1": e instanceof Error ? e.message : "Export failed unexpectedly.",
      });
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setRunning(false);
    }
  }, [running]);

  const handleSaveWeb = (clip: ExportedClip) => {
    Haptics.selectionAsync();
    const anchor = document.createElement("a");
    anchor.href = clip.uri;
    anchor.download = clip.fileName;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  };

  const handleShareNative = async (clip: ExportedClip) => {
    Haptics.selectionAsync();
    try {
      const Sharing = await import("expo-sharing");
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(clip.uri, {
          mimeType: clip.mimeType,
          dialogTitle: clip.fileName,
        });
      } else {
        setErrors({ [clip.layerIndex]: "Sharing is not available on this device." });
      }
    } catch {
      setErrors({ [clip.layerIndex]: "Sharing the clip failed." });
    }
  };

  const clipByIndex = new Map(clips.map((c) => [c.layerIndex, c]));
  const allDone = clips.length === ordered.length && !running;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onClose}
          accessibilityLabel="Close export panel"
        />
        <View
          style={[
            styles.sheet,
            { backgroundColor: colors.card, paddingBottom: insets.bottom + 16 },
          ]}
        >
          {/* ── Header ── */}
          <View style={styles.header}>
            <View style={styles.headerCenter}>
              <Text
                style={[
                  styles.title,
                  { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide },
                ]}
              >
                EXPORT CLIPS
              </Text>
              <Text style={[styles.subtitle, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                each layer&apos;s loop phrase · in layer order
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              style={styles.closeBtn}
              accessibilityRole="button"
              accessibilityLabel="Close export panel"
            >
              <Ionicons name="chevron-down" size={22} color={colors.foreground} />
            </TouchableOpacity>
          </View>

          {/* ── Composite: one video with all layers ── */}
          {Platform.OS === "web" && (
            <View style={[styles.compositeCard, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
              <View style={styles.compositeInfo}>
                <Text style={[styles.compositeTitle, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
                  VIDEO · ALL LAYERS
                </Text>
                <Text style={[styles.compositeSub, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                  {loops.length} layer{loops.length !== 1 ? "s" : ""} composited · one master loop
                </Text>
                {compositeError && (
                  <Text style={[styles.errText, { fontFamily: font.thin, color: colors.accent }]}>
                    {compositeError}
                  </Text>
                )}
              </View>
              {composite ? (
                <TouchableOpacity
                  onPress={() => handleSaveComposite(composite)}
                  style={[styles.compositeBtn, { backgroundColor: colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel={`Save ${composite.fileName}`}
                >
                  <Ionicons name="download-outline" size={15} color={colors.primaryForeground} />
                  <Text style={[styles.compositeBtnTxt, { fontFamily: font.thin, color: colors.primaryForeground }]}>
                    Save Video
                  </Text>
                </TouchableOpacity>
              ) : (
                <TouchableOpacity
                  onPress={handleCompositeExport}
                  disabled={compositeRunning}
                  style={[styles.compositeBtn, { backgroundColor: compositeRunning ? colors.muted : colors.primary }]}
                  accessibilityRole="button"
                  accessibilityLabel="Export video with all layers"
                >
                  <Ionicons
                    name="videocam-outline"
                    size={15}
                    color={compositeRunning ? colors.mutedForeground : colors.primaryForeground}
                  />
                  <Text style={[styles.compositeBtnTxt, { fontFamily: font.thin, color: compositeRunning ? colors.mutedForeground : colors.primaryForeground }]}>
                    {compositeRunning ? "Rendering…" : "Export"}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* ── Status line ── */}
          {running && (
            <View style={styles.statusRow}>
              <Text style={[styles.statusText, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                materializing layer {Math.min(progress.done + 1, progress.total)} / {progress.total}…
              </Text>
            </View>
          )}
          {errors["-1"] && (
            <Text style={[styles.errText, { fontFamily: font.thin, color: colors.accent }]}>
              {errors["-1"]}
            </Text>
          )}

          {/* ── Layer list ── */}
          <ScrollView style={styles.list} showsVerticalScrollIndicator={false}>
            {ordered.length === 0 ? (
              <View style={[styles.emptyState, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}>
                <Ionicons name="videocam-outline" size={24} color={colors.mutedForeground} />
                <Text style={[styles.emptyTitle, { fontFamily: font.thin, color: colors.foreground }]}>
                  no layers yet
                </Text>
                <Text style={[styles.emptySub, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                  record a layer in the studio first, then come back to export
                </Text>
              </View>
            ) : (
              ordered.map((loop) => {
              const clip = clipByIndex.get(loop.layerIndex);
              const err = errors[loop.layerIndex];
              const startMs = clip?.windowMs[0] ?? loop.startTrim;
              const endMs = clip?.windowMs[1] ?? loop.endTrim;
              return (
                <View
                  key={loop.id}
                  style={[styles.row, { backgroundColor: colors.cardAlt, borderColor: colors.border }]}
                >
                  <View style={styles.rowInfo}>
                    <View style={styles.rowTop}>
                      <Text style={[styles.layerLabel, { fontFamily: font.thin, color: colors.foreground, letterSpacing: tracking.wide }]}>
                        LAYER {loop.layerIndex + 1}
                      </Text>
                      {clip?.untrimmed && (
                        <Text style={[styles.untrimmedTag, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                          FULL TAKE
                        </Text>
                      )}
                    </View>
                    <Text style={[styles.window, { fontFamily: font.mono, color: colors.mutedForeground }]}>
                      {fmt(startMs)} → {fmt(endMs)}
                      {clip ? ` · ${clip.fileName}` : ""}
                    </Text>
                    {err && <Text style={[styles.errText, { fontFamily: font.thin, color: colors.accent }]}>{err}</Text>}
                  </View>

                  {clip ? (
                    <TouchableOpacity
                      onPress={() =>
                        Platform.OS === "web" ? handleSaveWeb(clip) : handleShareNative(clip)
                      }
                      style={[styles.saveBtn, { backgroundColor: colors.primary }]}
                      accessibilityRole="button"
                      accessibilityLabel={`Save ${clip.fileName}`}
                    >
                      <Ionicons
                        name={Platform.OS === "web" ? "download-outline" : "share-outline"}
                        size={15}
                        color={colors.primaryForeground}
                      />
                      <Text style={[styles.saveTxt, { fontFamily: font.thin, color: colors.primaryForeground }]}>
                        {Platform.OS === "web" ? "Save" : "Share"}
                      </Text>
                    </TouchableOpacity>
                  ) : (
                    <View style={styles.pendingSlot}>
                      <Text style={[styles.pending, { fontFamily: font.thin, color: colors.mutedForeground }]}>
                        {running ? "…" : "waiting"}
                      </Text>
                    </View>
                  )}
                </View>
              );
            })
            )}
          </ScrollView>

          {/* ── Footer ── */}
          <TouchableOpacity
            onPress={handleExportAll}
            disabled={running || ordered.length === 0}
            style={[
              styles.exportBtn,
              {
                backgroundColor: running ? colors.muted : colors.primary,
              },
            ]}
            accessibilityRole="button"
            accessibilityLabel="Export all layer clips"
          >
            <Ionicons
              name="videocam-outline"
              size={17}
              color={running ? colors.mutedForeground : colors.primaryForeground}
            />
            <Text
              style={[
                styles.exportTxt,
                { fontFamily: font.thin, color: running ? colors.mutedForeground : colors.primaryForeground },
              ]}
            >
              {running
                ? `Exporting ${progress.done}/${progress.total}…`
                : allDone
                  ? "Export Again"
                  : "Export All Clips"}
            </Text>
          </TouchableOpacity>

          {Platform.OS !== "web" && (
            <Text style={[styles.nativeNote, { fontFamily: font.thin, color: colors.mutedForeground }]}>
              Composite video is exported by the web build. On device, layer takes are shared untrimmed.
            </Text>
          )}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" },
  sheet: {
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 16,
    paddingTop: 14,
    maxHeight: "80%",
  },
  header: { flexDirection: "row", alignItems: "center", marginBottom: 10 },
  headerCenter: { flex: 1, gap: 3 },
  title: { fontSize: 13 },
  subtitle: { fontSize: 11 },
  closeBtn: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
  statusRow: { paddingBottom: 8 },
  statusText: { fontSize: 12 },
  errText: { fontSize: 11, marginTop: 2 },
  compositeCard: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
    gap: 10,
  },
  compositeInfo: { flex: 1, gap: 3 },
  compositeTitle: { fontSize: 12 },
  compositeSub: { fontSize: 11 },
  compositeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 10,
  },
  compositeBtnTxt: { fontSize: 12 },
  list: { flexGrow: 0, marginTop: 4 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 8,
    gap: 10,
  },
  rowInfo: { flex: 1, gap: 3 },
  rowTop: { flexDirection: "row", alignItems: "center", gap: 8 },
  layerLabel: { fontSize: 11 },
  untrimmedTag: { fontSize: 9, letterSpacing: 1 },
  window: { fontSize: 11 },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  saveTxt: { fontSize: 12 },
  pendingSlot: { minWidth: 64, alignItems: "center" },
  pending: { fontSize: 11 },
  exportBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 14,
    marginTop: 8,
  },
  exportTxt: { fontSize: 14 },
  nativeNote: { fontSize: 10, textAlign: "center", marginTop: 10 },
  emptyState: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 32,
    paddingHorizontal: 24,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  emptyTitle: { fontSize: 14 },
  emptySub: { fontSize: 12, textAlign: "center", lineHeight: 18 },
});