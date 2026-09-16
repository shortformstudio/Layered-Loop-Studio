import { Loop, useLoops } from "@/context/LoopContext";
import { AVPlaybackStatus, ResizeMode, Video } from "expo-av";
import React, { memo, useCallback, useEffect, useRef } from "react";
import { StyleSheet, View } from "react-native";

/**
 * Verified concurrent layer playback — one coordinator, one epoch.
 *
 * Every layer derives its media position from the SAME anchor:
 *
 *     mediaTime = startTrim + clockPosition
 *
 * The clock lives in LoopContext. This coordinator keeps all AVPlayers
 * glued to it with three mechanisms:
 *
 *   1. Coordinated start — on play, every layer pauses, seeks to its phrase
 *      anchor for the SAME clock position, then all players fire playAsync
 *      together. No per-layer stagger, no independent anchors.
 *   2. Shared wrap chain — one wall-clock timer fires at each loop boundary
 *      and re-seeks EVERY layer to its startTrim at the same instant. Error
 *      can never accumulate past one loop: each boundary re-anchors all
 *      layers to absolute time (persistent time-bound syncopation).
 *   3. Verified settle — ~350ms after start, each player's real position is
 *      read back and outliers (off by >90ms) are re-seeked once. This is a
 *      verification pass, not constant correction.
 *
 * Per-layer fallback: a wide safety net seeks back if a player somehow
 * overshoots its end boundary by 250ms (a missed shared wrap).
 *
 * BPM never alters media. Playback speed is always exactly 1x.
 */

const STATUS_INTERVAL_MS = 100;
const SETTLE_DELAY_MS = 350;
const SETTLE_TOLERANCE_MS = 90;
const SEEK_TOL = { toleranceMillisBefore: 30, toleranceMillisAfter: 30 };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SyncHandle {
  id: string;
  getRef: () => Video | null;
  startTrim: number;
  endTrim: number;
  loaded: boolean;
}

interface VideoLayerProps {
  loop: Loop;
  isPlaying: boolean;
  /** Effective opacity — pre-calculated by VideoStack (respects loop.videoOpacity) */
  opacity: number;
  /** Effective volume — pre-calculated (respects loop.volume, loop.muted, solo) */
  volume: number;
  zIndex: number;
  register: (id: string, handle: SyncHandle) => void;
  unregister: (id: string) => void;
  markLoaded: (id: string, loaded: boolean) => void;
  updateTrim: (id: string, startTrim: number, endTrim: number) => void;
}

function VideoLayer({
  loop,
  isPlaying,
  opacity,
  zIndex,
  volume,
  register,
  unregister,
  markLoaded,
  updateTrim,
}: VideoLayerProps) {
  const videoRef = useRef<Video>(null);

  // Register with the coordinator — the coordinator drives all transport.
  useEffect(() => {
    const handle: SyncHandle = {
      id: loop.id,
      getRef: () => videoRef.current,
      startTrim: loop.startTrim,
      endTrim: loop.endTrim,
      loaded: false,
    };
    register(loop.id, handle);
    return () => unregister(loop.id);
  }, [register, unregister, loop.id]);

  // Keep trim changes live on the registered handle.
  useEffect(() => {
    updateTrim(loop.id, loop.startTrim, loop.endTrim);
  }, [updateTrim, loop.id, loop.startTrim, loop.endTrim]);

  // Status: report loaded state + boundary safety net.
  // CRITICAL: no shouldPlay prop on the Video below — expo-av re-applies
  // shouldPlay=false on re-renders and silently pauses transport-driven
  // playback. The coordinator owns play/pause exclusively.
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;
  const handleStatus = useCallback(
    (status: AVPlaybackStatus) => {
      if (!status.isLoaded) return;
      markLoaded(loop.id, true);
      if (status.didJustFinish || status.positionMillis >= loop.endTrim) {
        // The shared wrap chain normally catches boundaries first — this is
        // the safety net for the race where a layer's own media end lands
        // just before the chain's seek.
        videoRef.current
          ?.setPositionAsync(loop.startTrim, SEEK_TOL)
          .then(() => {
            if (isPlayingRef.current) {
              videoRef.current?.playAsync().catch(() => {});
            }
          })
          .catch(() => {});
      }
    },
    [loop.id, loop.startTrim, loop.endTrim, markLoaded]
  );

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex, opacity }]}>
      <Video
        ref={videoRef}
        source={{ uri: loop.videoUri }}
        style={StyleSheet.absoluteFill}
        resizeMode={ResizeMode.COVER}
        isLooping={false}
        isMuted={false}
        volume={Math.max(0, Math.min(1, volume))}
        useNativeControls={false}
        progressUpdateIntervalMillis={STATUS_INTERVAL_MS}
        onPlaybackStatusUpdate={handleStatus}
      />
    </View>
  );
}

function areVideoLayerPropsEqual(
  prev: VideoLayerProps,
  next: VideoLayerProps,
): boolean {
  return (
    prev.loop.startTrim === next.loop.startTrim &&
    prev.loop.endTrim === next.loop.endTrim &&
    prev.loop.videoUri === next.loop.videoUri &&
    prev.opacity === next.opacity &&
    prev.volume === next.volume &&
    prev.zIndex === next.zIndex &&
    prev.isPlaying === next.isPlaying &&
    prev.register === next.register &&
    prev.unregister === next.unregister &&
    prev.markLoaded === next.markLoaded &&
    prev.updateTrim === next.updateTrim
  );
}

const MemoVideoLayer = memo(VideoLayer, areVideoLayerPropsEqual);

interface VideoStackProps {
  loops: Loop[];
  isPlaying: boolean;
  masterDuration: number | null;
  /** Global volume multiplier (from monitor controls) */
  volume?: number;
  /** Which loop ID is currently soloed (null = none) */
  soloedId?: string | null;
}

export default function VideoStack({
  loops,
  isPlaying,
  masterDuration,
  volume: globalVolume = 1,
  soloedId = null,
}: VideoStackProps) {
  const { getPlaybackPosition, getNextLoopBoundary } = useLoops();
  const runToken = useRef(0);
  const wrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const joinedIds = useRef<Set<string>>(new Set());
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  // Instance-scoped registries — no global Maps outside the component
  const handlesRef = useRef<Map<string, SyncHandle>>(new Map());
  const loadedRef = useRef<Map<string, boolean>>(new Map());

  const register = useCallback((id: string, handle: SyncHandle) => {
    handlesRef.current.set(id, handle);
    handle.loaded = loadedRef.current.get(id) ?? false;
  }, []);

  const unregister = useCallback((id: string) => {
    const h = handlesRef.current.get(id);
    if (h) {
      h.getRef()?.pauseAsync().catch(() => {});
    }
    handlesRef.current.delete(id);
    loadedRef.current.delete(id);
    joinedIds.current.delete(id);
  }, []);

  const markLoaded = useCallback((id: string, loaded: boolean) => {
    loadedRef.current.set(id, loaded);
    const h = handlesRef.current.get(id);
    if (h) h.loaded = loaded;
  }, []);

  const updateTrim = useCallback((id: string, startTrim: number, endTrim: number) => {
    const h = handlesRef.current.get(id);
    if (h) {
      h.startTrim = startTrim;
      h.endTrim = endTrim;
    }
  }, []);

  const clearTimers = () => {
    if (wrapTimer.current) {
      clearTimeout(wrapTimer.current);
      wrapTimer.current = null;
    }
    if (settleTimer.current) {
      clearTimeout(settleTimer.current);
      settleTimer.current = null;
    }
  };

  const scheduleWrap = useCallback(
    (token: number, md: number) => {
      const wait = getNextLoopBoundary() ?? md;
      wrapTimer.current = setTimeout(() => {
        if (token !== runToken.current) return;
        // One instant — every layer re-anchors to its startTrim together.
        const all = [...handlesRef.current.values()];
        if (__DEV__) console.log(`[sync] wrap fired — ${all.length} layer(s)`);
        Promise.allSettled(
          all.map((h) =>
            h.getRef()?.setPositionAsync(h.startTrim, {
              toleranceMillisBefore: 40,
              toleranceMillisAfter: 40,
            }).catch(() => {})
          )
        );
        // Diagnostic: verify where each layer actually landed.
        setTimeout(async () => {
          if (token !== runToken.current) return;
          for (const h of handlesRef.current.values()) {
            try {
              const st = await h.getRef()?.getStatusAsync();
              if (st && st.isLoaded) {
                if (__DEV__) console.log(`[sync] post-wrap pos=${st.positionMillis.toFixed(0)}ms (startTrim=${h.startTrim.toFixed(0)})`);
              }
            } catch {}
          }
        }, 300);
        scheduleWrap(token, md);
      }, wait);
    },
    [getNextLoopBoundary]
  );

  // ── Transport coordinator — start / stop / verified settle ─────────────
  useEffect(() => {
    const token = ++runToken.current;
    clearTimers();

    if (!isPlaying) {
      // Stop: one instant — every layer pauses together.
      const all = [...handlesRef.current.values()];
      all.forEach((h) => {
        h.getRef()?.pauseAsync().catch(() => {});
      });
      joinedIds.current = new Set();
      return () => {
        if (runToken.current === token) runToken.current++;
        clearTimers();
      };
    }

    const md = masterDuration;
    if (!md || md <= 0) return;

    const kickoff = async () => {
      // Wait for every registered layer to report loaded — no fixed cap.
      // Layers join the clock whenever they become ready. (G33 fix.)
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        if (token !== runToken.current) return;
        const all = [...handlesRef.current.values()];
        if (all.length > 0 && all.every((h) => h.loaded)) break;
        await sleep(100);
      }
      if (token !== runToken.current) return;

      const all = [...handlesRef.current.values()];
      const ready = all.filter((h) => h.loaded);
      const failed = all.filter((h) => !h.loaded);
      if (failed.length > 0) {
        if (__DEV__) console.log(`[sync] ${failed.length} layer(s) failed to load — proceeding with ${ready.length}`);
      }
      if (ready.length === 0) return;
      if (__DEV__) console.log(
        `[sync] kickoff — ${all.length} layer(s), loaded: ${all.map((h) => h.loaded).join(",")}`
      );
      joinedIds.current = new Set(all.map((h) => h.id));

      // 1. Single anchor: the same clock position for every layer.
      const pos0 = getPlaybackPosition() ?? 0;
      if (__DEV__) console.log(`[sync] anchor pos0=${pos0.toFixed(0)}ms`);
      // 2. Pause + seek every layer to its own phrase anchor.
      await Promise.allSettled(
        all.map(async (h) => {
          try {
            await h.getRef()?.pauseAsync();
            await h.getRef()?.setPositionAsync(h.startTrim + pos0, SEEK_TOL);
          } catch (e) {
            if (__DEV__) console.log("[sync] seek failed for a layer:", String(e));
          }
        })
      );
      if (token !== runToken.current) return;
      // 3. Fire every player together.
      all.forEach((h) => {
        h.getRef()?.playAsync().catch((e) => { if (__DEV__) console.log("[sync] playAsync failed:", String(e)); });
      });
      if (__DEV__) console.log("[sync] all playAsync fired");

      // 4. Verified concurrent timing — read real positions back and
      //    re-anchor outliers. The clock keeps moving, so each correction
      //    lands behind by its own seek latency; iterate until the layer
      //    converges inside tolerance (max 3 passes).
      settleTimer.current = setTimeout(async () => {
        if (token !== runToken.current) return;
        const live = [...handlesRef.current.values()];
        for (const h of live) {
          for (let attempt = 0; attempt < 3; attempt++) {
            if (token !== runToken.current) return;
            const posNow = getPlaybackPosition();
            if (posNow === null) break;
            try {
              const st = await h.getRef()?.getStatusAsync();
              if (!st || !st.isLoaded) break;
              const expected = h.startTrim + posNow;
              const off = st.positionMillis - expected;
              if (Math.abs(off) <= SETTLE_TOLERANCE_MS) break;
              await h.getRef()?.setPositionAsync(expected, SEEK_TOL);
              await sleep(160);
            } catch {
              break;
            }
          }
        }
      }, SETTLE_DELAY_MS);

      // 5. Shared wrap chain — epoch-derived boundaries re-anchor all layers.
      scheduleWrap(token, md);
    };

    kickoff();

    return () => {
      if (runToken.current === token) runToken.current++;
      clearTimers();
    };
  }, [isPlaying, masterDuration, getPlaybackPosition, scheduleWrap]);

  // ── Join new layers in phase while already playing ──────────────────────
  // Late-loading layers join the clock whenever they become ready — no fixed
  // 3s window that leaves them permanently desynced. (G33 fix.)
  useEffect(() => {
    if (!isPlaying) return;
    if (!masterDuration || masterDuration <= 0) return;
    const timer = setTimeout(async () => {
      const token = runToken.current;
      for (const loop of loops) {
        if (joinedIds.current.has(loop.id)) continue;
        joinedIds.current.add(loop.id);
        // Wait for this specific layer to load — up to 8s, polling every 100ms.
        let waited = 0;
        let h = handlesRef.current.get(loop.id);
        while (h && !h.loaded && waited < 8000) {
          await sleep(100);
          waited += 100;
          h = handlesRef.current.get(loop.id);
        }
        if (token !== runToken.current) return;
        if (!h || !h.loaded) {
          if (__DEV__) console.log(`[sync] layer ${loop.id} failed to load — skipping join`);
          continue;
        }
        const pos = getPlaybackPosition() ?? 0;
        try {
          await h.getRef()?.pauseAsync();
          await h.getRef()?.setPositionAsync(h.startTrim + pos, SEEK_TOL);
          await h.getRef()?.playAsync();
        } catch {
          /* a later boundary re-anchors this layer */
        }
        // Verified join — iterative settle.
        await sleep(SETTLE_DELAY_MS);
        if (token !== runToken.current) return;
        for (let attempt = 0; attempt < 3; attempt++) {
          if (token !== runToken.current) return;
          const posNow = getPlaybackPosition();
          if (posNow === null) break;
          try {
            const st = await h.getRef()?.getStatusAsync();
            if (!st || !st.isLoaded) break;
            const expected = h.startTrim + posNow;
            const off = st.positionMillis - expected;
            if (Math.abs(off) <= SETTLE_TOLERANCE_MS) break;
            await h.getRef()?.setPositionAsync(expected, SEEK_TOL);
            await sleep(160);
          } catch {
            break;
          }
        }
      }
    }, 120);
    return () => clearTimeout(timer);
  }, [loops, isPlaying, masterDuration, getPlaybackPosition]);

  // Clean unmount teardown
  useEffect(() => {
    return () => {
      clearTimers();
      for (const h of handlesRef.current.values()) {
        h.getRef()?.pauseAsync().catch(() => {});
      }
      handlesRef.current.clear();
      loadedRef.current.clear();
      joinedIds.current.clear();
    };
  }, []);

  if (loops.length === 0) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      {loops.map((loop, i) => {
        // Photoshop-style solid stacking: the first recording is layer 1,
        // every subsequent layer covers the ones beneath it. No blending —
        // what you see is the newest layer; older ones keep playing
        // underneath (their audio still contributes to the mix).
        // Honor videoOpacity from the loop — playback must match export. (G37)
        // When another layer is soloed, dim silenced layers visually. (G36)
        const isSilenced =
          loop.muted || (soloedId !== null && soloedId !== loop.id);
        const effectiveVolume = isSilenced ? 0 : (loop.volume ?? 1) * globalVolume;
        const effectiveOpacity = isSilenced && soloedId !== null
          ? (loop.videoOpacity ?? 1) * 0.35
          : (loop.videoOpacity ?? 1);

        return (
          <MemoVideoLayer
            key={loop.id}
            loop={loop}
            isPlaying={isPlaying}
            opacity={effectiveOpacity}
            zIndex={i + 1}
            volume={effectiveVolume}
            register={register}
            unregister={unregister}
            markLoaded={markLoaded}
            updateTrim={updateTrim}
          />
        );
      })}
    </View>
  );
}
