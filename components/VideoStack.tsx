import { Loop } from "@/context/LoopContext";
import { createVideoPlayer, VideoView } from "expo-video";
import type { VideoPlayer } from "expo-video";
import React, { useEffect, useRef, useState } from "react";
import { StyleSheet, View } from "react-native";

const clampRate = (r: number) => Math.max(0.25, Math.min(2, r));
const clampVolume = (v: number) => Math.max(0, Math.min(1, v));

const SEEK_LEAD_MS = 150;
const RESYNC_EVERY_N_LOOPS = 30;

interface VideoLayerProps {
  loop: Loop;
  isPlaying: boolean;
  opacity: number;
  volume: number;
  zIndex: number;
  rate?: number;
}

function VideoLayer({ loop, isPlaying, opacity, zIndex, volume, rate = 1 }: VideoLayerProps) {
  const playerRef = useRef<VideoPlayer | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seekingRef = useRef(false);
  const epochRef = useRef<number>(0);
  const activeRef = useRef(false);
  const loopCountRef = useRef(0);
  const [, setReady] = useState(false);

  useEffect(() => {
    const p = createVideoPlayer({ uri: loop.videoUri });
    p.loop = false;
    p.muted = false;
    p.volume = clampVolume(volume);
    p.playbackRate = clampRate(rate);
    playerRef.current = p;
    setReady(true);
    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
      try {
        p.pause();
        p.release();
      } catch {}
      playerRef.current = null;
    };
  }, [loop.videoUri]);

  useEffect(() => {
    const p = playerRef.current;
    if (p) {
      p.volume = clampVolume(volume);
      p.playbackRate = clampRate(rate);
    }
  }, [volume, rate]);

  useEffect(() => {
    const p = playerRef.current;
    if (timerRef.current) clearTimeout(timerRef.current);
    activeRef.current = false;

    if (!isPlaying || !p) {
      if (p) {
        try {
          p.pause();
        } catch {}
      }
      return;
    }

    const loopLen = loop.endTrim - loop.startTrim;
    if (loopLen <= 0) return;

    const clampedRate = clampRate(rate);
    const realLoopLen = loopLen / clampedRate;

    activeRef.current = true;
    loopCountRef.current = 0;

    const kickoff = async () => {
      try {
        p.currentTime = loop.startTrim / 1000;
        p.play();
      } catch {
        if (!activeRef.current) return;
        epochRef.current = Date.now();
        scheduleNext(1);
        return;
      }
      if (!activeRef.current) return;
      epochRef.current = Date.now();
      scheduleNext(1);
    };

    const scheduleNext = (n: number) => {
      if (!activeRef.current) return;

      loopCountRef.current = n;
      if (n % RESYNC_EVERY_N_LOOPS === 0) {
        epochRef.current = Date.now() - n * realLoopLen;
      }

      const nextBoundary = epochRef.current + n * realLoopLen;
      const delay = Math.max(0, nextBoundary - SEEK_LEAD_MS - Date.now());

      timerRef.current = setTimeout(async () => {
        if (!activeRef.current) return;
        if (!seekingRef.current) {
          seekingRef.current = true;
          try {
            p.currentTime = loop.startTrim / 1000;
          } catch {
            seekingRef.current = false;
            scheduleNext(n + 1);
            return;
          }
          seekingRef.current = false;
        }
        scheduleNext(n + 1);
      }, delay);
    };

    kickoff();

    return () => {
      activeRef.current = false;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [isPlaying, loop.startTrim, loop.endTrim, rate]);

  return (
    <View style={[StyleSheet.absoluteFill, { zIndex, opacity }]}>
      {playerRef.current ? (
        <VideoView
          player={playerRef.current}
          style={StyleSheet.absoluteFill}
          contentFit="cover"
          nativeControls={false}
        />
      ) : null}
    </View>
  );
}

interface VideoStackProps {
  loops: Loop[];
  isPlaying: boolean;
  volume?: number;
  soloedId?: string | null;
  rate?: number;
}

export default function VideoStack({
  loops,
  isPlaying,
  volume: globalVolume = 1,
  soloedId = null,
  rate = 1,
}: VideoStackProps) {
  if (loops.length === 0) return null;

  return (
    <View style={StyleSheet.absoluteFill}>
      {loops.map((loop, i) => {
        const isSilenced =
          loop.muted || (soloedId !== null && soloedId !== loop.id);
        const effectiveVolume = isSilenced ? 0 : (loop.volume ?? 1) * globalVolume;
        const effectiveOpacity = isSilenced && soloedId !== null
          ? (loop.videoOpacity ?? 1) * 0.35
          : (loop.videoOpacity ?? 1);

        return (
          <VideoLayer
            key={loop.id}
            loop={loop}
            isPlaying={isPlaying}
            opacity={effectiveOpacity}
            zIndex={i + 1}
            volume={effectiveVolume}
            rate={rate}
          />
        );
      })}
    </View>
  );
}
