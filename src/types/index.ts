/* ------------------------------------------------------------------ *
 * Vision analysis
 * ------------------------------------------------------------------ */

/** Normalised [0..1] box in image space: x/y are the top-left corner. */
export interface NormBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where the interesting bits of the dog are, in normalised image space.
 * The vision model fills these in; `deriveAnchors` synthesises a usable
 * fallback from the alpha mask when the model declines to cooperate.
 */
export interface DogAnchors {
  head: NormBox;
  mouth: NormBox;
  leftEye: NormBox | null;
  rightEye: NormBox | null;
  /** Rough pivot the body rotates about when rolling/bouncing. */
  chest: { x: number; y: number };
}

export interface DogAnalysis {
  breed: string;
  mood: string;
  personality: string;
  monologue: string;
  suggestedVoice: VoicePersonaId;
  hashtags: string[];
  anchors: DogAnchors | null;
  /** Model's read on energy level, 0 = sleepy lump, 1 = full zoomies. */
  energy: number;
}

/* ------------------------------------------------------------------ *
 * Speech
 * ------------------------------------------------------------------ */

export type VoicePersonaId = "deep" | "playful" | "dramatic" | "sassy";

export interface WordTimestamp {
  word: string;
  start: number;
  end: number;
}

export interface TTSResult {
  audioBlob: Blob;
  audioUrl: string;
  wordTimestamps: WordTimestamp[];
  durationMs: number;
}

/**
 * Precomputed audio analysis. Sampled on a fixed grid so that
 * `renderFrame(t)` can look up any time without touching an AudioContext.
 */
export interface AudioEnvelope {
  /** Samples per second of the envelope grid (not the audio sample rate). */
  rate: number;
  /** Smoothed loudness in [0..1], one entry per 1/rate seconds. */
  values: Float32Array;
  /** Rectified positive derivative of `values` - speech onsets. */
  onsets: Float32Array;
  durationSec: number;
}

/* ------------------------------------------------------------------ *
 * Layers (post-segmentation)
 * ------------------------------------------------------------------ */

export interface LayerSet {
  /** Original photo, used as-is when segmentation is unavailable. */
  source: ImageBitmap;
  /** Dog with background knocked out (premultiplied alpha). */
  cutout: ImageBitmap | null;
  /** Tight bounding box of non-transparent pixels in `cutout`. */
  cutoutBox: NormBox | null;
  width: number;
  height: number;
}

/* ------------------------------------------------------------------ *
 * Animation rig
 * ------------------------------------------------------------------ */

export type PresetId = "idle" | "roll" | "bounce" | "zoomies";

/**
 * Tunable coefficients for the animation formula. Every field maps to a
 * term documented in `render/rig.ts`; presets are just different points
 * in this space rather than different code paths.
 */
export interface RigConfig {
  preset: PresetId;

  /** Peak jaw displacement as a fraction of mouth-box height. */
  jawMax: number;
  /** Envelope thresholds for the smoothstep driving jaw open. */
  jawGateLow: number;
  jawGateHigh: number;

  /** Breathing amplitude (fractional scale) and frequency in Hz. */
  breathAmp: number;
  breathHz: number;

  /** Head sway amplitude in normalised units, plus its two frequencies. */
  swayAmp: number;
  swayHzA: number;
  swayHzB: number;

  /** Head tilt amplitude in radians. */
  tiltAmp: number;

  /** Emphasis-nod spring: stiffness, damping ratio, onset gain + gate. */
  nodStiffness: number;
  nodDamping: number;
  nodGain: number;
  nodThreshold: number;

  /** Mean seconds between blinks (Poisson rate is 1/this). */
  blinkIntervalSec: number;

  /** Ken Burns start/end zoom, plus handheld shake amplitude. */
  zoomStart: number;
  zoomEnd: number;
  shakeAmp: number;

  /** How strongly the background counter-moves. 0 = locked, 1 = equal. */
  parallax: number;

  /** Body roll amplitude in radians (drives `roll` / `zoomies`). */
  rollAmp: number;
  rollHz: number;

  /** Vertical hop amplitude in normalised units. */
  hopAmp: number;
  hopHz: number;
}

/** Everything the renderer needs for one frame. Pure output of the rig. */
export interface RigState {
  jaw: number;
  breath: number;
  swayX: number;
  swayY: number;
  tilt: number;
  nod: number;
  blink: number;
  zoom: number;
  shakeX: number;
  shakeY: number;
  bgX: number;
  bgY: number;
  roll: number;
  hop: number;
  /** Raw envelope value at this instant, handy for reactive backgrounds. */
  energy: number;
}

/* ------------------------------------------------------------------ *
 * Captions
 * ------------------------------------------------------------------ */

export type CaptionStyle = "karaoke" | "popup" | "minimal";

export interface CaptionConfig {
  enabled: boolean;
  style: CaptionStyle;
  /** Font size as a fraction of canvas height. */
  sizeRatio: number;
  /** Vertical centre of the caption block, 0 = top, 1 = bottom. */
  positionY: number;
  highlightColor: string;
  textColor: string;
  /** Max words visible in the rolling window. */
  windowSize: number;
  uppercase: boolean;
}

/* ------------------------------------------------------------------ *
 * Backgrounds
 * ------------------------------------------------------------------ */

export type BackgroundId = "original" | "blur" | "sunset" | "studio" | "park" | "neon" | "solid";

export interface BackgroundConfig {
  id: BackgroundId;
  /** Used by `solid`, and as the accent hue for procedural scenes. */
  color: string;
  /** Blur radius in pixels for the `blur` background. */
  blurPx: number;
  /** Whether the background pulses with the audio envelope. */
  reactive: boolean;
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export type ExportFormat = "mp4" | "webm" | "gif";

export interface ExportConfig {
  format: ExportFormat;
  width: number;
  height: number;
  fps: number;
  /** Video bitrate in bits per second. */
  bitrate: number;
}

/* ------------------------------------------------------------------ *
 * Project + settings
 * ------------------------------------------------------------------ */

export type ProjectStatus =
  "idle" | "analyzing" | "segmenting" | "generating-voice" | "previewing" | "exporting" | "done" | "error";

export interface VideoProject {
  id: string;
  /** Multiple angles of the same dog; index 0 is the hero shot. */
  imageFiles: File[];
  imageUrls: string[];
  activeImageIndex: number;
  layers: LayerSet | null;
  analysis: DogAnalysis | null;
  ttsResult: TTSResult | null;
  envelope: AudioEnvelope | null;
  status: ProjectStatus;
  error: string | null;
}

export type AiProvider = "gemini" | "ollama";

export interface ApiKeys {
  elevenLabsKey: string;
  geminiKey: string;
  aiProvider: AiProvider;
  geminiModel: string;
  ollamaUrl: string;
  ollamaModel: string;
  ollamaKey: string;
}

/* ------------------------------------------------------------------ *
 * Defaults
 * ------------------------------------------------------------------ */

export const VOICE_MAP: Record<VoicePersonaId, string> = {
  deep: "pNInz6obpgDQGcFmaJgB", // Adam
  playful: "EXAVITQu4vr4xnSDxMaL", // Bella
  dramatic: "onwK4e9ZLuTAKqWW03F9", // Daniel
  sassy: "XB0fDUnXU5powFXDhCwa", // Charlotte
};

export const DEFAULT_API_KEYS: ApiKeys = {
  elevenLabsKey: "",
  geminiKey: "",
  aiProvider: "gemini",
  geminiModel: "gemini-flash-latest",
  // Empty means "Ollama Cloud via the same-origin rewrite" - see services/vision.ts.
  ollamaUrl: "",
  // Must be a model Ollama *Cloud* hosts, since that's the default endpoint.
  // qwen3-vl and llama3.2-vision are local-only and 404 here; gemma4:31b is
  // the lightest cloud-hosted vision model.
  ollamaModel: "gemma4:31b",
  ollamaKey: "",
};

export const DEFAULT_CAPTIONS: CaptionConfig = {
  enabled: true,
  style: "karaoke",
  sizeRatio: 0.052,
  positionY: 0.76,
  highlightColor: "#FFD84D",
  textColor: "#FFFFFF",
  windowSize: 5,
  uppercase: true,
};

export const DEFAULT_BACKGROUND: BackgroundConfig = {
  id: "blur",
  color: "#F59E0B",
  blurPx: 28,
  reactive: true,
};

export const DEFAULT_EXPORT: ExportConfig = {
  format: "mp4",
  width: 1080,
  height: 1920,
  fps: 30,
  bitrate: 8_000_000,
};
