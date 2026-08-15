/**
 * Audio → envelope analysis.
 *
 * Produces the loudness curve that drives the jaw, the emphasis nods, and any
 * reactive background. Everything is computed once, up front, into fixed-rate
 * Float32Arrays - the renderer must never touch an AudioContext, because
 * offline export runs faster than real time and there'd be nothing to read.
 *
 * The important part is the *asymmetric* smoothing. See `smoothAsymmetric`.
 */

import type { AudioEnvelope } from "../types";

/** Envelope grid resolution. 200 Hz ≈ 5ms, well past what the eye resolves. */
const ENVELOPE_RATE = 200;

/** RMS window. 20ms is long enough to smooth glottal pulses, short enough
 *  to preserve consonant attacks. */
const RMS_WINDOW_SEC = 0.02;

/** Attack: how fast the envelope may rise. Fast, because consonants are sharp. */
const TAU_ATTACK = 0.015;

/** Release: how fast it may fall. Slow, because a jaw has mass and doesn't
 *  snap shut between syllables. This asymmetry is the whole trick. */
const TAU_RELEASE = 0.09;

let sharedContext: AudioContext | null = null;

function getContext(): AudioContext {
  if (!sharedContext || sharedContext.state === "closed") {
    sharedContext = new (
      window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    )();
  }
  return sharedContext;
}

/**
 * One-pole smoothing with different time constants for rising and falling
 * signals.
 *
 *   coeff = 1 - exp(-dt / tau)
 *   y[n]  = y[n-1] + (x[n] - y[n-1]) * coeff
 *
 * With a single tau, a mouth tracks loudness like a VU meter - it flutters
 * shut between every syllable and reads as mechanical. Splitting the constant
 * so it rises in ~15ms but falls over ~90ms matches how an actual jaw behaves:
 * muscles snap it open, then gravity and tissue elasticity ease it closed.
 * This single change does more for perceived lip-sync quality than any amount
 * of phoneme detection.
 */
function smoothAsymmetric(input: Float32Array, rate: number, tauAttack: number, tauRelease: number): Float32Array {
  const dt = 1 / rate;
  const attackCoeff = 1 - Math.exp(-dt / tauAttack);
  const releaseCoeff = 1 - Math.exp(-dt / tauRelease);

  const out = new Float32Array(input.length);
  let y = 0;

  for (let i = 0; i < input.length; i++) {
    const x = input[i];
    const coeff = x > y ? attackCoeff : releaseCoeff;
    y += (x - y) * coeff;
    out[i] = y;
  }

  return out;
}

/**
 * Rectified positive derivative - where loudness is *increasing* sharply.
 * These are the moments a speaker leans into a word, and they're what we kick
 * the emphasis-nod spring with. Normalised against its own peak so the nod
 * behaves the same on a whispered clip and a shouted one.
 */
function computeOnsets(values: Float32Array, rate: number): Float32Array {
  const out = new Float32Array(values.length);
  let peak = 0;

  for (let i = 1; i < values.length; i++) {
    const slope = (values[i] - values[i - 1]) * rate;
    const positive = slope > 0 ? slope : 0;
    out[i] = positive;
    if (positive > peak) peak = positive;
  }

  if (peak > 1e-6) {
    for (let i = 0; i < out.length; i++) out[i] /= peak;
  }

  return out;
}

/**
 * Downmix to mono and compute windowed RMS on the envelope grid.
 *
 * RMS rather than peak amplitude because RMS tracks perceived loudness - peak
 * is dominated by transients and would make the jaw twitch on plosives.
 */
function computeRms(buffer: AudioBuffer, rate: number): Float32Array {
  const sampleRate = buffer.sampleRate;
  const channels = buffer.numberOfChannels;
  const frames = buffer.length;

  const steps = Math.max(1, Math.ceil((frames / sampleRate) * rate));
  const out = new Float32Array(steps);
  const halfWindow = Math.floor((RMS_WINDOW_SEC * sampleRate) / 2);

  // Pull channel data out once; getChannelData is not free inside a hot loop.
  const data: Float32Array[] = [];
  for (let c = 0; c < channels; c++) data.push(buffer.getChannelData(c));

  for (let i = 0; i < steps; i++) {
    const centre = Math.floor((i / rate) * sampleRate);
    const start = Math.max(0, centre - halfWindow);
    const end = Math.min(frames, centre + halfWindow);
    const count = end - start;

    if (count <= 0) {
      out[i] = 0;
      continue;
    }

    let sum = 0;
    for (let c = 0; c < channels; c++) {
      const ch = data[c];
      for (let s = start; s < end; s++) {
        const v = ch[s];
        sum += v * v;
      }
    }

    out[i] = Math.sqrt(sum / (count * channels));
  }

  return out;
}

/**
 * Normalise against a high percentile rather than the absolute max.
 *
 * A single clipped sample or a stray breath pop would otherwise set the
 * ceiling and squash the entire rest of the curve into the bottom of the
 * range, leaving the dog mumbling. The 95th percentile ignores those outliers.
 */
function normalisePercentile(values: Float32Array, percentile = 0.95): void {
  if (values.length === 0) return;

  const sorted = Float32Array.from(values).sort();
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  const ceiling = sorted[idx];

  if (ceiling < 1e-6) return;

  for (let i = 0; i < values.length; i++) {
    const v = values[i] / ceiling;
    values[i] = v > 1 ? 1 : v;
  }
}

/**
 * Analyse an audio blob into a renderer-ready envelope.
 *
 * Works for both ElevenLabs TTS output and a user-supplied recording, since
 * `decodeAudioData` handles any format the browser can play.
 */
export async function analyzeAudio(blob: Blob): Promise<AudioEnvelope> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = getContext();

  // decodeAudioData detaches the ArrayBuffer on some engines, so hand it a copy
  // if the caller might reuse the blob's buffer elsewhere.
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

  const rms = computeRms(buffer, ENVELOPE_RATE);
  normalisePercentile(rms);

  const values = smoothAsymmetric(rms, ENVELOPE_RATE, TAU_ATTACK, TAU_RELEASE);

  // Re-normalise: smoothing lowers the peaks, and we want the loudest moment
  // to reliably hit a fully open jaw.
  normalisePercentile(values, 0.98);

  const onsets = computeOnsets(values, ENVELOPE_RATE);

  return {
    rate: ENVELOPE_RATE,
    values,
    onsets,
    durationSec: buffer.duration,
  };
}

/**
 * True playback duration, in ms. Preferred over the last word timestamp, which
 * omits any trailing silence and would cut the tail off the export.
 */
export async function getAudioDurationMs(blob: Blob): Promise<number> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = getContext();
  const buffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
  return buffer.duration * 1000;
}

/** Decoded PCM, needed by the MP4 exporter to feed AudioEncoder. */
export async function decodeToPcm(blob: Blob): Promise<AudioBuffer> {
  const arrayBuffer = await blob.arrayBuffer();
  const ctx = getContext();
  return ctx.decodeAudioData(arrayBuffer.slice(0));
}
