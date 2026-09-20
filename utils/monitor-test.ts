/**
 * Monitor route verification — a short sine test tone played through the
 * active audio session (the same one used while recording). The user
 * confirms where they heard it: headphones, bluetooth, speaker…
 *
 * Native: generates a 16-bit PCM WAV in JS, writes it to the cache, plays
 * it through expo-av. Web: Web Audio oscillator. No assets, no deps.
 */
import { Platform } from "react-native";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";

const SAMPLE_RATE = 44100;
const TONE_SECONDS = 0.9;
const FREQ = 440;

function encodeWavPcm16(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const dataSize = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataSize);
  const v = new DataView(buf);
  const wstr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
  };
  wstr(0, "RIFF");
  v.setUint32(4, 36 + dataSize, true);
  wstr(8, "WAVE");
  wstr(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  wstr(36, "data");
  v.setUint32(40, dataSize, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, samples[i], true);
  }
  return buf;
}

function buildToneSamples(): Int16Array {
  const n = Math.floor(SAMPLE_RATE * TONE_SECONDS);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const attack = Math.min(1, i / (SAMPLE_RATE * 0.02));
    const release = Math.min(1, (n - i) / (SAMPLE_RATE * 0.08));
    samples[i] = Math.round(
      Math.sin((2 * Math.PI * FREQ * i) / SAMPLE_RATE) * 0.6 * attack * release * 32767
    );
  }
  return samples;
}

async function playToneNative(): Promise<void> {
  const wav = encodeWavPcm16(buildToneSamples(), SAMPLE_RATE);
  const file = new File(Paths.cache, "looplayer-monitor-test.wav");
  file.write(new Uint8Array(wav));
  const player = createAudioPlayer(file.uri);
  player.volume = 1.0;
  player.play();
  setTimeout(() => {
    try {
      player.remove();
    } catch {}
  }, Math.round((TONE_SECONDS + 0.5) * 1000));
}

async function playToneWeb(): Promise<void> {
  const Ctor =
    (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!Ctor) return;
  const ctx: AudioContext = new Ctor();
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = FREQ;
  gain.gain.setValueAtTime(0, ctx.currentTime);
  gain.gain.linearRampToValueAtTime(0.6, ctx.currentTime + 0.02);
  gain.gain.linearRampToValueAtTime(0, ctx.currentTime + TONE_SECONDS);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + TONE_SECONDS + 0.05);
  setTimeout(() => ctx.close().catch(() => {}), 1500);
}

/** Play the verification tone through the live monitor session. */
export function playMonitorTestTone(): Promise<void> {
  if (Platform.OS === "web") return playToneWeb();
  return playToneNative();
}
