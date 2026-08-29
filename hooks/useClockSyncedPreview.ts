import { useCallback, useEffect, useRef } from "react";
import { Video } from "expo-av";

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
  videoRef: React.RefObject<Video | null>,
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
    const target = bracketMsRef.current + pos;
    if (Math.abs(videoPosRef.current - target) > 250) {
      videoRef.current?.setPositionAsync(target).catch(() => {});
      videoPosRef.current = target;
    }
    // Wrap at the master boundary with a short lead, matching VideoLayer.
    if (boundaryTimer.current) clearTimeout(boundaryTimer.current);
    const wait = Math.max(0, mdRef.current - pos - 150);
    boundaryTimer.current = setTimeout(() => {
      const b = bracketMsRef.current;
      videoRef.current?.setPositionAsync(b).catch(() => {});
      videoPosRef.current = b;
    }, wait);
  }, [getPlaybackPosition, videoRef, bracketMsRef]);

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
      videoRef.current?.setPositionAsync(bracketMs + pos).catch(() => {});
      videoPosRef.current = bracketMs + pos;
    },
    [getPlaybackPosition, videoRef]
  );

  return { videoPosRef, jumpTo };
}
