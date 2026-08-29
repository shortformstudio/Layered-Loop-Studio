/**
 * Audio analysis for intelligent trimming.
 *
 * On web: decodes the recording via the Web Audio API and derives
 *   • a real RMS energy envelope → 80-point waveform (loudness curve)
 *   • an onset-strength envelope → autocorrelation → detected BPM
 *   • beat positions fitted to that tempo
 *
 * On native: the recording is an HEVC/MP4 file and Expo Go has no PCM
 * decoder in reach, so we fall back to a deterministic (stable) synthetic
 * waveform. Beat snapping still works there once the user sets a BPM.
 *
 * The function never throws — any failure degrades to the synthetic fallback.
 */

export interface AudioAnalysis {
  /** 80 normalized amplitude points, 0..1 — real loudness envelope on web */
  waveformData: number[];
  /** Detected beats per minute; null when no reliable tempo is found */
  bpm: number | null;
  /** Beat times (ms into the recording), empty when bpm is null */
  beatTimesMs: number[];
}

const WAVE_POINTS = 80;
const MIN_BPM = 60;
const MAX_BPM = 200;
const WINDOW = 1024; // samples per analysis window (~21ms @ 48k)
const HOP = 512;     // overlap → ~93 windows/sec @ 48k
const SNAP_PEAK_MIN = 0.28; // autocorrelation strength required to trust a tempo

/** Deterministic pseudo-random waveform (native fallback). */
export function syntheticWaveform(seed: string, count = WAVE_POINTS): number[] {
  let s = seed.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  const rand = () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
  const data: number[] = [];
  for (let i = 0; i < count; i++) {
    const sine1 = Math.abs(Math.sin(i * 0.25 + s * 0.05));
    const sine2 = Math.abs(Math.sin(i * 0.08 + s * 0.02));
    const noise = rand();
    data.push(Math.max(0.05, Math.min(1.0, sine1 * 0.35 + sine2 * 0.3 + noise * 0.35)));
  }
  return data;
}

export async function analyzeAudio(uri: string): Promise<AudioAnalysis> {
  const AudioContextCtor =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) {
    return { waveformData: syntheticWaveform(uri), bpm: null, beatTimesMs: [] };
  }

  try {
    const buffer = await fetch(uri).then((r) => r.arrayBuffer());
    const ctx = new AudioContextCtor();
    try {
      // Safari ≤ 14 exposes only the callback form of decodeAudioData
      const audio = await new Promise<AudioBuffer>((resolve, reject) => {
        const decoded = ctx.decodeAudioData(buffer, resolve, reject);
        if (decoded && typeof decoded.then === "function") {
          (decoded as unknown as Promise<AudioBuffer>).then(resolve, reject);
        }
      });
      const { envelope, onsets, windowsPerSecond } = computeEnvelope(audio);
      const waveformData = downsample(envelope, WAVE_POINTS);
      const { bpm, lag } = detectBpm(onsets, windowsPerSecond);
      const beatTimesMs = bpm && lag > 0 ? fitBeats(onsets, lag, windowsPerSecond) : [];
      return { waveformData, bpm, beatTimesMs };
    } finally {
      ctx.close().catch(() => {});
    }
  } catch {
    return { waveformData: syntheticWaveform(uri), bpm: null, beatTimesMs: [] };
  }
}

interface EnvelopeResult {
  envelope: Float64Array;
  onsets: Float64Array;
  windowsPerSecond: number;
}

function computeEnvelope(audio: AudioBuffer): EnvelopeResult {
  const sr = audio.sampleRate;
  const len = audio.length;
  const channels = audio.numberOfChannels;
  const windows = Math.max(1, Math.floor((len - WINDOW) / HOP) + 1);

  const mono = new Float32Array(len);
  for (let c = 0; c < channels; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < len; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < len; i++) mono[i] /= channels;
  }

  const env = new Float64Array(windows);
  for (let w = 0; w < windows; w++) {
    const off = w * HOP;
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) {
      const v = mono[off + i];
      sum += v * v;
    }
    env[w] = Math.sqrt(sum / WINDOW);
  }

  let max = 0;
  for (let i = 0; i < windows; i++) if (env[i] > max) max = env[i];
  if (max > 0) for (let i = 0; i < windows; i++) env[i] /= max;

  return {
    envelope: env,
    onsets: computeOnsets(env),
    windowsPerSecond: sr / HOP,
  };
}

/** Positive energy deltas — peaks where a new sound begins. */
function computeOnsets(env: Float64Array): Float64Array {
  const n = env.length;
  const raw = new Float64Array(n);
  for (let i = 1; i < n; i++) raw[i] = Math.max(0, env[i] - env[i - 1]);
  const out = new Float64Array(n);
  for (let i = 2; i < n - 2; i++) {
    out[i] = (raw[i - 2] + raw[i - 1] + raw[i] * 2 + raw[i + 1] + raw[i + 2]) / 6;
  }
  return out;
}

function downsample(data: Float64Array, count: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i / count) * data.length);
    const end = Math.max(start + 1, Math.floor(((i + 1) / count) * data.length));
    let sum = 0;
    for (let j = start; j < end; j++) sum += data[j];
    out.push(Math.max(0.05, Math.min(1, sum / (end - start))));
  }
  return out;
}

interface BpmResult {
  bpm: number | null;
  lag: number;
}

/**
 * Normalized autocorrelation of the onset envelope over the lag range
 * corresponding to MIN_BPM..MAX_BPM. Returns the best tempo, preferring
 * the slower reading when a strong peak also exists at double the lag
 * (protects against 8th-note doublings).
 */
function detectBpm(onsets: Float64Array, windowsPerSecond: number): BpmResult {
  const n = onsets.length;
  const minLag = Math.max(1, Math.floor((windowsPerSecond * 60) / MAX_BPM));
  const maxLag = Math.ceil((windowsPerSecond * 60) / MIN_BPM);
  if (n < maxLag + 2) return { bpm: null, lag: 0 };

  let bestLag = -1;
  let bestNorm = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const m = n - lag;
    let corr = 0;
    let e = 0;
    for (let i = 0; i < m; i++) {
      corr += onsets[i] * onsets[i + lag];
      e += onsets[i] * onsets[i];
    }
    const norm = e > 0 ? corr / e : 0;
    if (norm > bestNorm) {
      bestNorm = norm;
      bestLag = lag;
    }
  }
  if (bestLag < 0 || bestNorm < SNAP_PEAK_MIN) return { bpm: null, lag: 0 };

  const dblLag = bestLag * 2;
  if (dblLag <= maxLag) {
    const m = n - dblLag;
    let corr = 0;
    let e = 0;
    for (let i = 0; i < m; i++) {
      corr += onsets[i] * onsets[i + dblLag];
      e += onsets[i] * onsets[i];
    }
    const norm = e > 0 ? corr / e : 0;
    if (norm >= bestNorm * 0.82) {
      bestLag = dblLag;
      bestNorm = norm;
    }
  }

  const bpm = (windowsPerSecond * 60) / bestLag;
  return { bpm: Math.round(bpm), lag: bestLag };
}

/**
 * Fits the beat phase (0..lag) that maximizes onset energy at beat
 * positions, then returns the resulting beat times in milliseconds.
 */
function fitBeats(onsets: Float64Array, lag: number, windowsPerSecond: number): number[] {
  let bestPhase = 0;
  let best = -Infinity;
  for (let p = 0; p < lag; p++) {
    let e = 0;
    for (let k = p; k < onsets.length; k += lag) e += onsets[k];
    if (e > best) {
      best = e;
      bestPhase = p;
    }
  }
  const msPerHop = 1000 / windowsPerSecond;
  const beats: number[] = [];
  for (let k = bestPhase; k < onsets.length; k += lag) {
    beats.push(k * msPerHop);
  }
  return beats;
}
