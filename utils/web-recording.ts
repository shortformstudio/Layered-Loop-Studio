export function getSupportedMimeType(): string {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
    "video/mp4",
  ];
  for (const type of candidates) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  return "video/webm";
}

export interface WebRecordingOptions {
  maxDuration?: number;
}

export interface WebRecordingResult {
  uri: string;
}

export class WebRecorder {
  private mediaRecorder: MediaRecorder | null = null;
  private videoClones: MediaStreamTrack[] = [];
  private chunks: Blob[] = [];
  private pendingResolve: ((value: WebRecordingResult) => void) | null = null;
  private pendingReject: ((reason: Error) => void) | null = null;
  private maxDurationTimer: ReturnType<typeof setTimeout> | null = null;
  private audioStream: MediaStream | null = null;
  private recordedUri: string | null = null;
  private stopRequested = false;
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private levelCtx: AudioContext | null = null;
  /** Single-flight guard — prevents concurrent start() calls. (G19) */
  private starting = false;
  /** Live amplitude callback (0..1) — fired ~10x/sec while recording. */
  onLevel: ((level: number) => void) | null = null;

  private startLevelProbe(): void {
    const stream = this.audioStream;
    const Ctor =
      (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
    if (!stream || !Ctor) return;
    try {
      const ctx: AudioContext = new Ctor();
      this.levelCtx = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      this.levelTimer = setInterval(() => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i++) {
          const v = Math.abs(data[i] - 128) / 128;
          if (v > peak) peak = v;
        }
        this.onLevel?.(Math.min(1, peak * 1.6));
      }, 100);
    } catch {
      /* level probing is optional — recording continues without it */
    }
  }

  private stopLevelProbe(): void {
    if (this.levelTimer) {
      clearInterval(this.levelTimer);
      this.levelTimer = null;
    }
    if (this.levelCtx) {
      this.levelCtx.close().catch(() => {});
      this.levelCtx = null;
    }
  }

  async start(
    videoElement: HTMLVideoElement,
    options?: WebRecordingOptions,
  ): Promise<WebRecordingResult> {
    // Single-flight guard — return the in-flight promise on rapid double-tap. (G19)
    if (this.starting || this.mediaRecorder?.state === "recording") {
      throw new Error("A recording is already in progress.");
    }
    this.starting = true;
    this.stopRequested = false;

    const videoStream = videoElement.srcObject as MediaStream | null;
    if (!videoStream || videoStream.getVideoTracks().length === 0) {
      this.starting = false;
      throw new Error("No camera stream available. Ensure camera permissions are granted and the camera preview is active.");
    }

    // Set up the promise BEFORE getUserMedia so cancel()/dispose() during the
    // await window properly reject the caller. (G34 race fix.)
    return new Promise<WebRecordingResult>((resolve, reject) => {
      this.pendingResolve = resolve;
      this.pendingReject = reject;

      (async () => {
        let audioStream: MediaStream | null = null;
        try {
          audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        } catch {
          this.starting = false;
          reject(new Error("Microphone access is required to record audio. Please allow microphone access in your browser settings."));
          return;
        }

        // If cancel()/dispose() was called while awaiting getUserMedia, bail.
        if (this.stopRequested) {
          audioStream.getTracks().forEach((t) => t.stop());
          this.starting = false;
          reject(new Error("Recording cancelled."));
          return;
        }

        this.audioStream = audioStream;
        this.startLevelProbe();
        this.videoClones = videoStream.getVideoTracks().map((t) => t.clone());
        const combinedStream = new MediaStream([
          ...this.videoClones,
          ...audioStream.getAudioTracks(),
        ]);

        const mimeType = getSupportedMimeType();
        this.mediaRecorder = new MediaRecorder(combinedStream, {
          mimeType,
          videoBitsPerSecond: 8_000_000,
        });
        this.chunks = [];

        this.mediaRecorder.ondataavailable = (e) => {
          if (e.data.size > 0) {
            this.chunks.push(e.data);
          }
        };

        this.mediaRecorder.onstop = () => {
          const uri = URL.createObjectURL(new Blob(this.chunks, { type: mimeType }));
          const settledResolve = this.pendingResolve;
          this.pendingResolve = null;
          this.starting = false;
          this.cleanup();
          if (settledResolve) {
            this.recordedUri = uri;
            settledResolve({ uri });
          } else {
            URL.revokeObjectURL(uri);
          }
        };

        this.mediaRecorder.onerror = () => {
          const settledReject = this.pendingReject;
          this.starting = false;
          this.cleanup();
          settledReject?.(new Error("MediaRecorder encountered an error during recording."));
        };

        try {
          this.mediaRecorder.start(1000);
        } catch (e) {
          const settledReject = this.pendingReject;
          this.starting = false;
          this.cleanup();
          settledReject?.(
            new Error(`MediaRecorder failed to start: ${e instanceof Error ? e.message : String(e)}`)
          );
          return;
        }

        if (this.stopRequested) {
          this.mediaRecorder.stop();
        }

        if (options?.maxDuration) {
          this.maxDurationTimer = setTimeout(() => {
            if (this.mediaRecorder?.state === "recording") {
              this.mediaRecorder.stop();
            }
          }, options.maxDuration * 1000);
        }
      })();
    });
  }

  stop(): void {
    this.stopRequested = true;
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
    }
  }

  /** Abort an in-flight recording without producing a clip. */
  cancel(): void {
    this.stopRequested = true;
    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
    }
    // If we're still in the getUserMedia window, the start() promise will
    // see stopRequested and reject itself.
    const settledReject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.starting = false;
    settledReject?.(new Error("Recording cancelled."));
  }

  /** Release the mic and any cloned camera tracks; reject a pending start. */
  dispose(): void {
    const settledReject = this.pendingReject;
    this.pendingResolve = null;
    this.pendingReject = null;
    this.starting = false;
    this.cleanup();
    settledReject?.(new Error("Recording stopped."));
  }

  revokeLastUri(): void {
    if (this.recordedUri) {
      URL.revokeObjectURL(this.recordedUri);
      this.recordedUri = null;
    }
  }

  private cleanup(): void {
    this.stopLevelProbe();
    if (this.maxDurationTimer) {
      clearTimeout(this.maxDurationTimer);
      this.maxDurationTimer = null;
    }
    if (this.audioStream) {
      this.audioStream.getTracks().forEach((t) => t.stop());
      this.audioStream = null;
    }
    if (this.videoClones.length > 0) {
      this.videoClones.forEach((t) => t.stop());
      this.videoClones = [];
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this.pendingResolve = null;
    this.pendingReject = null;
  }
}
