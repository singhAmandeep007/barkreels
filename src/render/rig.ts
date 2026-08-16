/**
 * The animation rig.
 *
 * Everything here is a *pure function of time*. `evaluateRig(t, ...)` returns
 * the complete pose for the instant `t` without reading a clock, without
 * mutating anything, and without caring whether we're painting a live preview
 * or grinding out frame 417 of an offline export. That property is what lets
 * the preview and the exporter share one code path and stay bit-identical.
 *
 * The one exception is the emphasis nod, which is a second-order spring and
 * therefore genuinely stateful. We handle that by *integrating it up front*
 * over the whole clip into a lookup table (see `precomputeNod`), which turns
 * it back into a pure sample-by-time. Same trick for blinks, which are a
 * random process seeded deterministically.
 *
 * Why the specific formulas:
 *
 *   Jaw     Driven by a smoothstep of the audio envelope, then raised to 0.75.
 *           A linear map makes the mouth track loudness like a VU meter, which
 *           reads as mechanical. Real jaws are gated (silence = fully shut) and
 *           compressive (the last 20% of opening takes disproportionate effort).
 *
 *   Sway    The sum of TWO sines at an irrational frequency ratio. A single
 *           sine has an obvious period and the eye locks onto it within about
 *           three cycles. Two incommensurable frequencies produce a pattern
 *           whose true period exceeds any clip length we'll ever render, so it
 *           never visibly repeats.
 *
 *   Nod     A damped spring kicked by envelope onsets. Damping ratio sits just
 *           under 1 so the head overshoots exactly once and settles - the
 *           signature of a real neck absorbing an impulse. Critically damped
 *           (ζ = 1) looks sedated; underdamped past ~0.7 looks like a bobblehead.
 *
 *   Blink   Poisson-distributed, with an asymmetric curve: eyelids slam shut in
 *           ~60ms and drift open over ~140ms. Uniform-interval blinking is one
 *           of the strongest "this is a puppet" tells there is.
 *
 *   Shake   Two octaves of value noise, not per-frame randomness. White noise
 *           reads as video compression artefacts; band-limited noise reads as a
 *           human holding a camera.
 */

import type { AudioEnvelope, PresetId, RigConfig, RigState } from "../types";

/* ------------------------------------------------------------------ *
 * Small deterministic helpers
 * ------------------------------------------------------------------ */

const TAU = Math.PI * 2;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01((x - edge0) / (edge1 - edge0 || 1e-6));
  return t * t * (3 - 2 * t);
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * Mulberry32 - tiny, fast, and crucially *seedable*. Reproducible randomness
 * matters here: the preview the user approves must be the video they export,
 * so blink times cannot come from Math.random().
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth 1-D value noise: lattice of random values, cubic-interpolated. */
function makeValueNoise(seed: number): (x: number) => number {
  const rand = mulberry32(seed);
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = rand() * 2 - 1;

  return (x: number) => {
    const xi = Math.floor(x);
    const xf = x - xi;
    const a = table[((xi % 256) + 256) % 256];
    const b = table[(((xi + 1) % 256) + 256) % 256];
    const u = xf * xf * (3 - 2 * xf);
    return a + (b - a) * u;
  };
}

/* ------------------------------------------------------------------ *
 * Envelope sampling
 * ------------------------------------------------------------------ */

function sampleEnvelope(env: AudioEnvelope | null, t: number): number {
  if (!env || env.values.length === 0) return 0;
  const idx = t * env.rate;
  const i0 = Math.floor(idx);
  if (i0 < 0) return env.values[0];
  if (i0 >= env.values.length - 1) return env.values[env.values.length - 1];
  const frac = idx - i0;
  return env.values[i0] * (1 - frac) + env.values[i0 + 1] * frac;
}

/* ------------------------------------------------------------------ *
 * Presets - points in RigConfig space, not separate code paths
 * ------------------------------------------------------------------ */

const BASE: RigConfig = {
  preset: "idle",

  jawMax: 0.42,
  jawGateLow: 0.08,
  jawGateHigh: 0.55,

  breathAmp: 0.012,
  breathHz: 0.28,

  swayAmp: 0.016,
  swayHzA: 0.37,
  swayHzB: 0.61,

  tiltAmp: 0.035,

  nodStiffness: 140,
  nodDamping: 0.55,
  nodGain: 0.6,
  // Onsets are normalised so the loudest in the clip is 1.0. A gate of 0.9
  // would therefore fire on exactly one word per video; 0.25 picks out the
  // genuinely emphasised handful.
  nodThreshold: 0.25,

  blinkIntervalSec: 3.5,

  earTwitchAmp: 0.18,
  earTwitchIntervalSec: 4.5,

  zoomStart: 1.0,
  zoomEnd: 1.14,
  shakeAmp: 0.004,

  parallax: 0.35,

  rollAmp: 0,
  rollHz: 0.2,

  hopAmp: 0,
  hopHz: 1.0,
};

export const PRESETS: Record<PresetId, RigConfig> = {
  /**
   * Locked off. The frame, the camera and the body do not move at all - only
   * the mouth, eyes and ears.
   *
   * This is the most convincing style for a portrait, and the reason is
   * counterintuitive: motion is what gives away that a photo is being puppeted.
   * Hold everything still and the viewer reads the frame as a real video of a
   * dog sitting calmly, so the only thing left to judge is the mouth - which
   * is the one part we drive from real audio. Breathing stays, very slightly,
   * because a perfectly rigid subject reads as a freeze-frame.
   */
  still: {
    ...BASE,
    preset: "still",
    swayAmp: 0,
    tiltAmp: 0,
    rollAmp: 0,
    hopAmp: 0,
    shakeAmp: 0,
    parallax: 0,
    zoomStart: 1.0,
    zoomEnd: 1.0,
    breathAmp: 0.004,
    nodGain: 0.12,
    earTwitchAmp: 0.22,
    earTwitchIntervalSec: 3.8,
  },

  /**
   * Still, plus the smallest amount of life: a barely perceptible drift and a
   * very slow push-in. Everything an inch from imperceptible, which is where
   * cinematography puts idle motion.
   */
  subtle: {
    ...BASE,
    preset: "subtle",
    swayAmp: 0.004,
    tiltAmp: 0.008,
    rollAmp: 0,
    hopAmp: 0,
    shakeAmp: 0.0008,
    parallax: 0.12,
    zoomStart: 1.0,
    zoomEnd: 1.035,
    breathAmp: 0.008,
    nodGain: 0.3,
    earTwitchAmp: 0.2,
  },

  /** Portrait mode: the dog talks to camera, everything else stays subtle. */
  idle: { ...BASE },

  /** Lazy sideways roll, like a dog flopping over for belly rubs. */
  roll: {
    ...BASE,
    preset: "roll",
    rollAmp: 0.22,
    rollHz: 0.16,
    swayAmp: 0.026,
    tiltAmp: 0.06,
    breathAmp: 0.02,
    zoomEnd: 1.08,
    parallax: 0.5,
  },

  /** Springy vertical hop synced loosely to speech rhythm. */
  bounce: {
    ...BASE,
    preset: "bounce",
    hopAmp: 0.035,
    hopHz: 1.35,
    nodGain: 0.9,
    swayAmp: 0.022,
    zoomEnd: 1.1,
    parallax: 0.45,
  },

  /** Maximum chaos: fast sway, roll, hop, aggressive camera. */
  zoomies: {
    ...BASE,
    preset: "zoomies",
    rollAmp: 0.14,
    rollHz: 0.55,
    hopAmp: 0.05,
    hopHz: 2.1,
    swayAmp: 0.038,
    swayHzA: 0.83,
    swayHzB: 1.39,
    tiltAmp: 0.09,
    nodGain: 1.2,
    shakeAmp: 0.009,
    zoomStart: 1.05,
    zoomEnd: 1.22,
    parallax: 0.6,
    blinkIntervalSec: 2.4,
  },
};

/**
 * Nudge a preset by the model's read on the dog's energy. A sleepy basset and
 * a manic border collie shouldn't animate identically even on the same preset.
 */
export function applyEnergy(config: RigConfig, energy: number): RigConfig {
  const e = clamp01(energy);
  const gain = 0.7 + e * 0.6; // 0.7x at zero energy, 1.3x at full
  return {
    ...config,
    swayAmp: config.swayAmp * gain,
    tiltAmp: config.tiltAmp * gain,
    hopAmp: config.hopAmp * gain,
    rollAmp: config.rollAmp * gain,
    nodGain: config.nodGain * gain,
    breathHz: config.breathHz * (0.85 + e * 0.4),
    blinkIntervalSec: config.blinkIntervalSec * (1.3 - e * 0.5),
    earTwitchIntervalSec: config.earTwitchIntervalSec * (1.4 - e * 0.6),
  };
}

/* ------------------------------------------------------------------ *
 * Precomputation - turns stateful processes into pure lookups
 * ------------------------------------------------------------------ */

export interface RigTables {
  /** Nod displacement sampled at `rate` Hz. */
  nod: Float32Array;
  /** Eyelid closure in [0..1] sampled at `rate` Hz. */
  blink: Float32Array;
  /** Per-ear lift in [0..1]. Separate tables so the ears act independently. */
  earLeft: Float32Array;
  earRight: Float32Array;
  rate: number;
  noiseX: (x: number) => number;
  noiseY: (x: number) => number;
  durationSec: number;
}

/**
 * Ear twitches: Poisson events with a springy, overshooting flick.
 *
 * Ears are the highest-value motion on an otherwise still dog. They're light,
 * so they move fast and settle with a visible wobble, and dogs twitch them
 * constantly while listening - which is exactly the read we want when a voice
 * is coming out of the animal.
 *
 * Seeded differently per side so the two never fire together; synchronised
 * ears look like a hat being lifted rather than an animal listening.
 */
function precomputeEarTwitch(intervalSec: number, durationSec: number, rate: number, seed: number): Float32Array {
  const steps = Math.max(1, Math.ceil(durationSec * rate));
  const out = new Float32Array(steps);
  const rand = mulberry32(seed);

  const lambda = 1 / Math.max(0.5, intervalSec);
  const FLICK_SEC = 0.42;

  let t = -Math.log(1 - rand()) / lambda;

  while (t < durationSec) {
    const start = Math.floor(t * rate);
    const len = Math.max(1, Math.round(FLICK_SEC * rate));
    // Vary each flick so repeated twitches don't look copy-pasted.
    const strength = 0.6 + rand() * 0.4;

    for (let i = 0; i < len; i++) {
      const idx = start + i;
      if (idx < 0 || idx >= steps) continue;

      // Decaying oscillation: sharp up, then two diminishing wobbles.
      const p = i / len;
      const value = Math.sin(p * Math.PI * 2.5) * Math.exp(-p * 4.2);
      out[idx] = Math.max(out[idx], Math.max(0, value) * strength);
    }

    t += -Math.log(1 - rand()) / lambda;
  }

  return out;
}

/**
 * Integrate the emphasis-nod spring across the whole clip.
 *
 *   nod'' = -k·nod - c·nod' + g·onset
 *
 * with c derived from the damping ratio ζ as c = 2ζ√k. We integrate at a fixed
 * 240 Hz using semi-implicit Euler - well above the spring's natural frequency
 * (√140 ≈ 11.8 rad/s ≈ 1.9 Hz), so it's stable and cheap.
 */
/**
 * Peak-pick discrete emphasis events from the onset curve.
 *
 * The raw onset signal is a continuous derivative with a spike on every
 * syllable edge, including tiny ones. Feeding it to the spring directly means
 * either nothing fires (high gate) or the head vibrates continuously (low
 * gate). What we actually want is the handful of moments a speaker leans on a
 * word.
 *
 * So: keep only local maxima above the gate, and enforce a refractory period.
 * 120ms is a little under the fastest syllable rate in natural speech - nobody
 * emphasises two separate words closer together than that, and without the
 * refractory a single broad onset registers as four or five events and the
 * spring gets kicked into a jitter.
 */
function pickOnsetEvents(envelope: AudioEnvelope | null, threshold: number): { time: number; strength: number }[] {
  if (!envelope || envelope.onsets.length === 0) return [];

  const REFRACTORY_SEC = 0.12;
  const events: { time: number; strength: number }[] = [];
  const { onsets, rate } = envelope;

  let lastTime = -Infinity;

  for (let i = 1; i < onsets.length - 1; i++) {
    const v = onsets[i];
    if (v < threshold) continue;
    if (v < onsets[i - 1] || v < onsets[i + 1]) continue; // not a local max

    const time = i / rate;
    if (time - lastTime < REFRACTORY_SEC) continue;

    events.push({ time, strength: v - threshold });
    lastTime = time;
  }

  return events;
}

/**
 * Converts a velocity impulse into the peak displacement it produces, so the
 * gain knob means something predictable.
 *
 * For a lightly damped oscillator kicked from rest, peak ≈ v₀/ω where
 * ω = √k. Inverting that lets us pick impulses in units of "how far should the
 * head actually move", rather than tuning a magic number by eye.
 */
const NOD_TARGET_PEAK = 0.25;

function precomputeNod(
  config: RigConfig,
  envelope: AudioEnvelope | null,
  durationSec: number,
  rate: number
): Float32Array {
  const steps = Math.max(1, Math.ceil(durationSec * rate));
  const out = new Float32Array(steps);

  const k = config.nodStiffness;
  const omega = Math.sqrt(k);
  const c = 2 * config.nodDamping * omega;
  const dt = 1 / rate;

  const events = pickOnsetEvents(envelope, config.nodThreshold);
  let nextEvent = 0;

  let pos = 0;
  let vel = 0;

  for (let i = 0; i < steps; i++) {
    const t = i / rate;

    // An emphasis is an *impulse*, not a sustained force: it changes velocity
    // instantaneously. Modelling it as a force applied for one timestep - the
    // obvious-looking version - delivers 1/240th of the momentum and the head
    // barely twitches.
    while (nextEvent < events.length && events[nextEvent].time <= t) {
      vel += events[nextEvent].strength * config.nodGain * NOD_TARGET_PEAK * omega;
      nextEvent++;
    }

    const accel = -k * pos - c * vel;
    vel += accel * dt;
    pos += vel * dt;

    out[i] = pos;
  }

  return out;
}

/**
 * Lay out blinks as a Poisson process, then paint each one's asymmetric curve
 * into a lookup table. Closing is roughly 2.3x faster than opening, which is
 * what makes a blink read as a blink rather than a slow wink.
 */
function precomputeBlinks(config: RigConfig, durationSec: number, rate: number, seed: number): Float32Array {
  const steps = Math.max(1, Math.ceil(durationSec * rate));
  const out = new Float32Array(steps);
  const rand = mulberry32(seed);

  const CLOSE_SEC = 0.06;
  const OPEN_SEC = 0.14;
  const lambda = 1 / Math.max(0.5, config.blinkIntervalSec);

  // Exponential inter-arrival times give a true Poisson process.
  let t = -Math.log(1 - rand()) / lambda;

  while (t < durationSec) {
    const startIdx = Math.floor(t * rate);
    const closeSteps = Math.max(1, Math.round(CLOSE_SEC * rate));
    const openSteps = Math.max(1, Math.round(OPEN_SEC * rate));

    for (let i = 0; i < closeSteps; i++) {
      const idx = startIdx + i;
      if (idx >= 0 && idx < steps) {
        // Ease-in: accelerating closure.
        const p = i / closeSteps;
        out[idx] = Math.max(out[idx], p * p);
      }
    }
    for (let i = 0; i < openSteps; i++) {
      const idx = startIdx + closeSteps + i;
      if (idx >= 0 && idx < steps) {
        // Ease-out: decelerating reopen.
        const p = i / openSteps;
        out[idx] = Math.max(out[idx], 1 - p * (2 - p));
      }
    }

    t += -Math.log(1 - rand()) / lambda;
  }

  return out;
}

export function buildRigTables(
  config: RigConfig,
  envelope: AudioEnvelope | null,
  durationSec: number,
  seed = 0xd06
): RigTables {
  const rate = 240;
  return {
    nod: precomputeNod(config, envelope, durationSec, rate),
    blink: precomputeBlinks(config, durationSec, rate, seed),
    earLeft: precomputeEarTwitch(config.earTwitchIntervalSec, durationSec, rate, seed ^ 0x1e47),
    earRight: precomputeEarTwitch(config.earTwitchIntervalSec, durationSec, rate, seed ^ 0x7c19),
    rate,
    noiseX: makeValueNoise(seed ^ 0x9e37),
    noiseY: makeValueNoise(seed ^ 0x85eb),
    durationSec,
  };
}

function sampleTable(table: Float32Array, rate: number, t: number): number {
  if (table.length === 0) return 0;
  const idx = t * rate;
  const i0 = Math.floor(idx);
  if (i0 < 0) return table[0];
  if (i0 >= table.length - 1) return table[table.length - 1];
  const frac = idx - i0;
  return table[i0] * (1 - frac) + table[i0 + 1] * frac;
}

/* ------------------------------------------------------------------ *
 * The rig itself
 * ------------------------------------------------------------------ */

/**
 * Evaluate the complete pose at time `t`. Pure: same inputs always produce the
 * same output, which is precisely why preview and export agree frame for frame.
 */
export function evaluateRig(t: number, config: RigConfig, envelope: AudioEnvelope | null, tables: RigTables): RigState {
  const E = sampleEnvelope(envelope, t);
  const duration = tables.durationSec || 1;
  const progress = clamp01(t / duration);

  /* --- Jaw: gated, compressive response to loudness ---------------- */
  const jaw = config.jawMax * Math.pow(smoothstep(config.jawGateLow, config.jawGateHigh, E), 0.75);

  /* --- Breathing: slow scale oscillation about the chest ----------- */
  const breath = 1 + config.breathAmp * Math.sin(TAU * config.breathHz * t);

  /* --- Head sway: two incommensurable sines ------------------------ *
   * The 1.1 rad phase offset on the second term stops the two waves
   * from peaking together at t=0, which would otherwise give the clip
   * a visible "kick" on the first frame.                              */
  const swayBase = Math.sin(TAU * config.swayHzA * t) + 0.5 * Math.sin(TAU * config.swayHzB * t + 1.1);
  const swayX = config.swayAmp * swayBase;

  // Vertical sway runs at a different pair of rates so the head traces a
  // wandering Lissajous figure rather than a straight diagonal line.
  const swayY =
    config.swayAmp *
    0.6 *
    (Math.sin(TAU * config.swayHzA * 0.71 * t + 2.3) + 0.5 * Math.sin(TAU * config.swayHzB * 0.83 * t));

  /* --- Tilt: same trick, slower, in radians ------------------------ */
  const tilt = config.tiltAmp * (Math.sin(TAU * 0.23 * t + 0.7) + 0.4 * Math.sin(TAU * 0.53 * t));

  /* --- Emphasis nod: precomputed spring ---------------------------- */
  const nod = sampleTable(tables.nod, tables.rate, t);

  /* --- Blink: precomputed Poisson process -------------------------- */
  const blink = clamp01(sampleTable(tables.blink, tables.rate, t));

  /* --- Ears: independent Poisson flicks ---------------------------- */
  const earLeft = config.earTwitchAmp * sampleTable(tables.earLeft, tables.rate, t);
  const earRight = config.earTwitchAmp * sampleTable(tables.earRight, tables.rate, t);

  /* --- Camera: eased Ken Burns + two-octave handheld noise ---------- */
  const zoom = config.zoomStart + (config.zoomEnd - config.zoomStart) * easeInOutCubic(progress);

  const shakeX = config.shakeAmp * (tables.noiseX(t * 0.9) + 0.5 * tables.noiseX(t * 2.3));
  const shakeY = config.shakeAmp * (tables.noiseY(t * 0.8) + 0.5 * tables.noiseY(t * 2.7));

  /* --- Body roll and hop ------------------------------------------- */
  const roll = config.rollAmp * Math.sin(TAU * config.rollHz * t);

  // |sin| gives the asymmetric arc of a bounce: quick at the bottom,
  // hanging at the apex. Squaring it sharpens the ground contact.
  const hopPhase = Math.abs(Math.sin(TAU * config.hopHz * t * 0.5));
  const hop = config.hopAmp * hopPhase * hopPhase;

  /* --- Background counter-parallax --------------------------------- *
   * Moving the background *against* the subject at a fraction of the
   * subject's displacement is the cheapest convincing depth cue there
   * is - it's how 2.5D parallax scrolling has faked depth since 1982.  */
  const bgX = -config.parallax * (swayX + shakeX);
  const bgY = -config.parallax * (swayY + shakeY);

  return {
    jaw,
    breath,
    swayX,
    swayY,
    tilt,
    nod,
    blink,
    zoom,
    shakeX,
    shakeY,
    bgX,
    bgY,
    roll,
    hop,
    earLeft,
    earRight,
    energy: E,
  };
}
