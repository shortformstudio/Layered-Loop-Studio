import { useCallback, useEffect, useRef } from "react";
import type { VideoPlayer } from "expo-video";

import { useLoops } from "@/context/LoopContext";

/**
 * Clock-synced preview audition.
 *
 * Chases the shared master clock: the bracketed section of a pending take
 * plays in phase with every recorded layer and wraps at each loop boundary
 * (150ms lead, matching VideoLayer). Drift-checked every clock tick.
 *
 * Used by EnvelopeDock (invisible audio-only audition) and TimelineBrowser
 * (visible full preview) — both for fresh takes.
 */
export function useClockSyncedPreview(
  playerRef: React.RefObject<VideoPlayer | null>,
  bracketMsRef: React.MutableRefObject<number>,
  active: boolean,
  masterDuration: number
) {
  const { subscribePlayback, getPlaybackPosition } = useLoops();

  const videoPosRef = useRef(0);
  const boundaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mdRef = useRef(masterDuration);
  mdRef.current = masterDuration;

  const chase = useCallback(() => {
    const pos = getPlaybackPosition();
    if (pos === null) return;
    const targetMs = bracketMsRef.current + pos;
    if (Math.abs(videoPosRef.current - targetMs) > 250) {
      if (playerRef.current) {
        playerRef.current.currentTime = targetMs / 1000;
      }
      videoPosRef.current = targetMs;
    }
    // Wrap at the master boundary with a short lead, matching VideoLayer.
    if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    const wait = Math.max(0, mdRef.current - pos - 150);
    boundaryTimer.current = setTimeout(() => {
      const b = bracketMsRef.current;
      if (playerRef.current) {
        playerRef.current.currentTime = b / 1000;
      }
      videoPosRef.current = b;
    }, wait);
  }, [getPlaybackPosition, playerRef, bracketMsRef]);

  useEffect(() => {
    if (!active) return;
    const unsub = subscribePlayback(chase);
    chase();
    return () => {
      unsub();
      if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    };
  }, [active, subscribePlayback, chase]);

  /** Jump instantly to a new bracket position, preserving clock phase. */
  const jumpTo = useCallback(
    (bracketMs: number) => {
      const pos = getPlaybackPosition();
      if (pos === null) return;
      const targetMs = bracketMs + pos;
      if (playerRef.current) {
        playerRef.current.currentTime = targetMs / 1000;
      }
      videoPosRef.current = targetMs;
    },
    [getPlaybackPosition, playerRef]
  );

  return { videoPosRef, jumpTo };
}
