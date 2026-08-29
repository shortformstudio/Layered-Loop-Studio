/**
 * Clip export — materializes the finalized loop windows as video files.
 *
 * Two products:
 *   • Composite (web)  — every layer rendered together in layer order (root
 *     at the back) into ONE video: one pass of the master loop, drawn per
 *     frame onto a canvas (COVER-fit, per-layer opacity), with each layer's
 *     audio routed through the Web Audio API at its layer volume. This is
 *     "the exported video with all layers".
 *   • Per-layer clips  — each layer's phrase as its own file.
 *
 * Web:   captureStream + MediaRecorder. Videos play muted to satisfy browser
 *        autoplay policy, then unmute once rolling (the captured track then
 *        carries audio). Composite audio runs through AudioContext media
 *        sources, which tap the media directly and are immune to element
 *        muting.
 * Native: expo-camera writes cache files; true trimming needs a native
 *        AVFoundation/MediaCodec module (not available in this managed
 *        build), so per-layer export copies the full take into the app's
 *        documents directory, flagged `untrimmed: true`. Composite export is
 *        offered by the web build only.
 */
import { Platform } from "react-native";
import type { Loop } from "@/context/LoopContext";
import { getSupportedMimeType } from "@/utils/web-recording";

export interface ExportedClip {
  layerIndex: number;
  fileName: string;
  mimeType: string;
  /** Same-origin object URL (web) or file:// URI (native). Revoked by the caller when done. */
  uri: string;
  /** The phrase rendered into the file, ms into the source recording */
  windowMs: [number, number];
  /** True when the file is the full take, not the trimmed phrase (native only) */
  untrimmed: boolean;
}

export interface CompositeClip {
  fileName: string;
  mimeType: string;
  uri: string;
  windowMs: [number, number];
  layerCount: number;
}

function extensionForMime(mime: string): string {
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("quicktime")) return "mov";
  return "webm";
}

/* ─────────────────────────── web: shared helpers ─────────────────────── */

function captureStreamOf(video: HTMLVideoElement): MediaStream | undefined {
  const capture = (video as HTMLVideoElement & {
    captureStream?: (frameRate?: number) => MediaStream;
  }).captureStream;
  return capture?.call(video);
}

function waitFor(video: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onEvent = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      resolve();
    };
    const onError = () => {
      video.removeEventListener(event, onEvent);
      video.removeEventListener("error", onError);
      reject(new Error(`Video failed during ${event}: ${video.error?.message ?? "unknown"}`));
    };
    video.addEventListener(event, onEvent, { once: true });
    video.addEventListener("error", onError);
  });
}

/** Seek a hidden video to a time and resolve once the frame is decodable. */
async function seekTo(video: HTMLVideoElement, ms: number): Promise<void> {
  if (Math.abs(video.currentTime * 1000 - ms) > 60 || video.readyState < 2) {
    video.currentTime = Math.max(0, ms / 1000);
    await waitFor(video, "seeked");
  }
}

/**
 * Start an unmuted-capable playback under autoplay policy:
 * begin muted (always allowed), then unmute once rolling.
 */
async function playAudibly(video: HTMLVideoElement): Promise<void> {
  video.muted = true;
  await video.play();
  video.muted = false;
}

/* ─────────────────────────── composite (web) ─────────────────────────── */

interface CompositeLayer {
  video: HTMLVideoElement;
  loop: Loop;
  gain: GainNode;
  opacity: number;
}

/**
 * Render one pass of the master loop with every layer composited.
 * Layer order = layerIndex order (root at the back).
 */
export async function exportCompositeOnWeb(
  loops: Loop[],
  masterDuration: number
): Promise<CompositeClip> {
  if (typeof document === "undefined" || !("MediaRecorder" in window)) {
    throw new Error("Composite export needs a modern browser with MediaRecorder.");
  }
  if (loops.length === 0 || masterDuration <= 0) {
    throw new Error("Nothing to export — record a loop first.");
  }

  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    throw new Error("This browser lacks Web Audio — cannot mix layer audio.");
  }

  const ordered = [...loops].sort((a, b) => a.layerIndex - b.layerIndex);
  const ctx = new AudioContextCtor();
  if (ctx.state === "suspended") await ctx.resume();
  const dest = ctx.createMediaStreamDestination();

  // Load + seek every layer first so the composite starts frame-aligned.
  const layers: CompositeLayer[] = [];
  const created: HTMLVideoElement[] = [];
  try {
    for (const loop of ordered) {
      const video = document.createElement("video");
      video.src = loop.fullRecordingUri || loop.videoUri;
      video.preload = "auto";
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      video.style.display = "none";
      document.body.appendChild(video);
      created.push(video);
      await waitFor(video, "loadedmetadata");
      await seekTo(video, loop.startTrim);

      const source = ctx.createMediaElementSource(video);
      const gain = ctx.createGain();
      gain.gain.value = loop.muted ? 0 : loop.volume ?? 1;
      source.connect(gain);
      gain.connect(dest);

      const i = loop.layerIndex;
      const opacity =
        loop.videoOpacity ??
        (i === ordered.length - 1 ? 1 : 0.28 + (i / Math.max(1, ordered.length - 1)) * 0.48);

      layers.push({ video, loop, gain, opacity });
    }

    // Output canvas sized from the first layer's frame, portrait-fitted.
    const first = layers[0].video;
    const baseW = Math.max(2, first.videoWidth || 1080);
    const baseH = Math.max(2, first.videoHeight || 1920);
    const canvas = document.createElement("canvas");
    canvas.width = baseW;
    canvas.height = baseH;
    const g = canvas.getContext("2d");
    if (!g) throw new Error("Canvas 2D context unavailable.");

    const mimeType = getSupportedMimeType();
    const stream = canvas.captureStream(60);
    dest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
    const recorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 10_000_000,
    });
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
      recorder.onerror = () => reject(new Error("MediaRecorder failed during composite export."));
    });

    // Kick every layer off together.
    for (const layer of layers) {
      await playAudibly(layer.video);
    }

    const epoch = performance.now();
    recorder.start(500);

    await new Promise<void>((resolve, reject) => {
      let lastPos = 0;
      let wrapped = false;
      let frames = 0;
      const draw = () => {
        const pos = (performance.now() - epoch) % masterDuration;
        if (pos < lastPos) wrapped = true;
        lastPos = pos;

        g.fillStyle = "#000";
        g.fillRect(0, 0, canvas.width, canvas.height);

        for (const layer of layers) {
          const { video, loop } = layer;
          const target = loop.startTrim + pos;
          const actual = video.currentTime * 1000;
          if (Math.abs(actual - target) > 120 && !video.seeking) {
            try {
              video.currentTime = Math.max(0, Math.min(loop.endTrim, target) / 1000);
            } catch { /* keep drawing; next frame re-clamps */ }
          }
          if (video.readyState < 2 || video.videoWidth === 0) continue;

          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const scale = Math.max(canvas.width / vw, canvas.height / vh);
          const w = vw * scale;
          const h = vh * scale;
          const x = (canvas.width - w) / 2;
          const y = (canvas.height - h) / 2;
          g.globalAlpha = Math.max(0, Math.min(1, layer.opacity));
          try {
            g.drawImage(video, x, y, w, h);
          } catch { /* frame not ready */ }
          g.globalAlpha = 1;
        }

        frames += 1;
        if (wrapped && pos >= 0 && frames > 30) {
          resolve();
          return;
        }
        requestAnimationFrame(draw);
      };
      requestAnimationFrame(draw);
      // Hard guard: one loop plus two seconds of headroom.
      setTimeout(() => resolve(), masterDuration + 2000);
    });

    if (recorder.state !== "inactive") recorder.stop();
    const blob = await stopped;
    const uri = URL.createObjectURL(blob);

    return {
      fileName: `LoopLayer Composition.${extensionForMime(blob.type)}`,
      mimeType: blob.type,
      uri,
      windowMs: [0, masterDuration],
      layerCount: layers.length,
    };
  } finally {
    created.forEach((v) => {
      v.pause();
      v.removeAttribute("src");
      v.load();
      v.remove();
    });
    ctx.close().catch(() => {});
  }
}

/* ───────────────────────── per-layer clips (web) ─────────────────────── */

async function trimClipOnWeb(loop: Loop): Promise<ExportedClip> {
  const video = document.createElement("video");
  video.src = loop.videoUri;
  video.preload = "auto";
  video.playsInline = true;
  video.style.display = "none";
  document.body.appendChild(video);

  try {
    await waitFor(video, "loadedmetadata");
    const startMs = Math.max(0, Math.min(loop.startTrim, loop.duration));
    const endMs = Math.max(startMs + 50, Math.min(loop.endTrim, loop.duration));
    await seekTo(video, startMs);

    const mimeType = getSupportedMimeType();
    const stream = captureStreamOf(video);
    if (!stream) {
      throw new Error(
        "This browser cannot capture trimmed video. Use a recent Chrome, Edge, or Safari."
      );
    }
    if (stream.getVideoTracks().length === 0) {
      throw new Error("The trimmed clip produced no video track.");
    }

    const mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: 8_000_000,
    });
    const chunks: Blob[] = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const stopped = new Promise<Blob>((resolve, reject) => {
      mediaRecorder.onstop = () =>
        resolve(new Blob(chunks, { type: mimeType }));
      mediaRecorder.onerror = () =>
        reject(new Error("MediaRecorder failed while exporting the clip."));
    });

    mediaRecorder.start(500);
    await playAudibly(video);

    const playMs = endMs - startMs;
    const hardStop = Date.now() + playMs + 2500;
    await new Promise<void>((resolve) => {
      const poll = () => {
        if (video.ended || video.currentTime * 1000 >= endMs - 30 || Date.now() >= hardStop) {
          resolve();
          return;
        }
        requestAnimationFrame(poll);
      };
      poll();
    });

    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
    const blob = await stopped;

    return {
      layerIndex: loop.layerIndex,
      fileName: `Layer ${loop.layerIndex + 1}.${extensionForMime(blob.type)}`,
      mimeType: blob.type,
      uri: URL.createObjectURL(blob),
      windowMs: [startMs, endMs],
      untrimmed: false,
    };
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
  }
}

/* ─────────────────────────── per-layer (native) ──────────────────────── */

async function copyClipOnNative(loop: Loop): Promise<ExportedClip> {
  const fs = await import("expo-file-system");
  const { File, Directory, Paths } = fs;
  const exportDir = new Directory(Paths.document, "LoopLayer Exports");
  if (!exportDir.exists) exportDir.create({ intermediates: true });

  const source = new File(loop.videoUri);
  const ext = source.extension || "mp4";
  const fileName = `Layer ${loop.layerIndex + 1}.${ext}`;
  const dest = new File(exportDir, fileName);
  // Always refresh — a re-trimmed layer must never reuse a stale file.
  if (dest.exists) dest.delete();
  source.copy(dest);

  return {
    layerIndex: loop.layerIndex,
    fileName,
    mimeType: ext === "mp4" ? "video/mp4" : "video/quicktime",
    uri: dest.uri,
    windowMs: [loop.startTrim, loop.endTrim],
    untrimmed: true,
  };
}

/* ───────────────────────────── public API ────────────────────────────── */

/** Materialize one loop's phrase as a video file. */
export async function exportLoopClip(loop: Loop): Promise<ExportedClip> {
  if (Platform.OS === "web") return trimClipOnWeb(loop);
  return copyClipOnNative(loop);
}

/** Materialize every layer, in layer order, reporting progress per layer. */
export async function exportAllClips(
  loops: Loop[],
  onProgress?: (done: number, total: number) => void
): Promise<ExportedClip[]> {
  const ordered = [...loops].sort((a, b) => a.layerIndex - b.layerIndex);
  const clips: ExportedClip[] = [];
  for (let i = 0; i < ordered.length; i++) {
    onProgress?.(i, ordered.length);
    clips.push(await exportLoopClip(ordered[i]));
    onProgress?.(i + 1, ordered.length);
  }
  return clips;
}
