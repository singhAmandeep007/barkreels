/**
 * Dev-only render harness.
 *
 * Exercises the whole render + export path with synthetic audio so the shader,
 * the rig, the captions and the muxer can be verified without burning API
 * credits or needing keys. Not part of the app bundle - Vite builds it as a
 * separate page and nothing in src/ imports it.
 */

import { FrameRenderer } from "./render/glRenderer";
import { exportVideo, isWebCodecsSupported } from "./render/exporter";
import { analyzeAudio } from "./services/audioAnalysis";
import { segmentImage, deriveAnchors } from "./services/segmentation";
import { PRESETS } from "./render/rig";
import { DEFAULT_BACKGROUND, DEFAULT_CAPTIONS, type WordTimestamp } from "./types";

const logEl = document.getElementById("log") as HTMLDivElement;
const canvas = document.getElementById("out") as HTMLCanvasElement;

function log(msg: string, cls = "") {
  logEl.innerHTML += `\n<span class="${cls}">${msg}</span>`;
}

/**
 * Synthesise a speech-like WAV: a 140Hz buzz gated into syllable-length bursts.
 * Real enough to exercise the envelope follower, the onset detector and the
 * jaw response without needing a TTS round trip.
 */
function makeSpeechWav(durationSec: number, sampleRate = 44100): Blob {
  const total = Math.floor(durationSec * sampleRate);
  const samples = new Float32Array(total);

  const syllables = Math.floor(durationSec * 4.2);
  for (let s = 0; s < syllables; s++) {
    const start = Math.floor((s / syllables) * total);
    const len = Math.floor(sampleRate * (0.1 + Math.random() * 0.09));
    const amp = 0.35 + Math.random() * 0.5;

    for (let i = 0; i < len && start + i < total; i++) {
      const env = Math.sin((Math.PI * i) / len) ** 1.4;
      const carrier =
        Math.sin((2 * Math.PI * 140 * i) / sampleRate) * 0.6 +
        Math.sin((2 * Math.PI * 280 * i) / sampleRate) * 0.3 +
        (Math.random() * 2 - 1) * 0.1;
      samples[start + i] += carrier * env * amp;
    }
  }

  const buffer = new ArrayBuffer(44 + total * 2);
  const view = new DataView(buffer);
  const str = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  str(0, "RIFF");
  view.setUint32(4, 36 + total * 2, true);
  str(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  str(36, "data");
  view.setUint32(40, total * 2, true);

  for (let i = 0; i < total; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v * 32767, true);
  }

  return new Blob([buffer], { type: "audio/wav" });
}

function makeWords(durationSec: number): WordTimestamp[] {
  const text = "I have been guarding this couch for six hours and nobody has thanked me even once".split(" ");
  const per = durationSec / text.length;
  return text.map((word, i) => ({
    word,
    start: i * per,
    end: (i + 1) * per * 0.86,
  }));
}

async function main() {
  logEl.textContent = "";
  const DURATION = 6;

  log(`WebCodecs: ${isWebCodecsSupported() ? "yes" : "NO"}`, isWebCodecsSupported() ? "ok" : "bad");

  /* --- Audio ------------------------------------------------------- */
  log("synthesising speech-like audio…");
  const audioBlob = makeSpeechWav(DURATION);
  const envelope = await analyzeAudio(audioBlob);

  let peak = 0,
    nonZero = 0;
  for (const v of envelope.values) {
    if (v > peak) peak = v;
    if (v > 0.01) nonZero++;
  }
  const coverage = nonZero / envelope.values.length;
  log(
    `envelope: ${envelope.values.length} samples @ ${envelope.rate}Hz, peak ${peak.toFixed(3)}, active ${(coverage * 100).toFixed(0)}%`,
    peak > 0.8 && coverage > 0.3 ? "ok" : "bad"
  );

  let onsetPeak = 0;
  for (const v of envelope.onsets) if (v > onsetPeak) onsetPeak = v;
  log(`onsets: peak ${onsetPeak.toFixed(3)}`, onsetPeak > 0.9 ? "ok" : "bad");

  /* --- Image + segmentation ---------------------------------------- */
  log("loading test_dog.jpg…");
  const res = await fetch("/test_dog.jpg");
  if (!res.ok) throw new Error(`test_dog.jpg → HTTP ${res.status}`);
  const imgBlob = await res.blob();
  log(`image: ${(imgBlob.size / 1024).toFixed(0)}kB`);

  log("segmenting (first run downloads the model)…");
  const t0 = performance.now();
  const layers = await segmentImage(
    imgBlob,
    (p) =>
      ((logEl.lastElementChild as HTMLElement).textContent = `segmenting: ${p.label} ${(p.fraction * 100).toFixed(0)}%`)
  );
  log(
    `segmented in ${((performance.now() - t0) / 1000).toFixed(1)}s - cutout: ${layers.cutout ? "yes" : "NO (fell back)"}`,
    layers.cutout ? "ok" : "warn"
  );
  log(
    `cutout box: ${
      layers.cutoutBox
        ? JSON.stringify(Object.fromEntries(Object.entries(layers.cutoutBox).map(([k, v]) => [k, +v.toFixed(3)])))
        : "none"
    }`
  );

  const anchors = deriveAnchors(layers.cutoutBox);

  /* --- Renderer ----------------------------------------------------- */
  log("building renderer…");
  const W = 540,
    H = 960;
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;

  const renderer = new FrameRenderer({
    layers,
    anchors,
    words: makeWords(DURATION),
    envelope,
    rigConfig: PRESETS.still,
    captions: DEFAULT_CAPTIONS,
    background: { ...DEFAULT_BACKGROUND, id: "blur" },
    durationSec: DURATION,
    width: W,
    height: H,
  });
  log("shader compiled + linked", "ok");

  /* --- Rig sanity --------------------------------------------------- */
  let jawMin = 1,
    jawMax = 0,
    blinkMax = 0,
    nodAbs = 0,
    earMax = 0,
    swayAbs = 0;
  for (let i = 0; i <= 600; i++) {
    const p = renderer.poseAt((i / 600) * DURATION);
    jawMin = Math.min(jawMin, p.jaw);
    jawMax = Math.max(jawMax, p.jaw);
    blinkMax = Math.max(blinkMax, p.blink);
    nodAbs = Math.max(nodAbs, Math.abs(p.nod));
    earMax = Math.max(earMax, p.earLeft, p.earRight);
    swayAbs = Math.max(swayAbs, Math.abs(p.swayX), Math.abs(p.swayY));
  }
  log(
    `rig - jaw ${jawMin.toFixed(3)}..${jawMax.toFixed(3)}, blink ${blinkMax.toFixed(2)}, nod ${nodAbs.toFixed(3)}, ear ${earMax.toFixed(3)}`,
    jawMax > 0.15 && blinkMax > 0.9 && earMax > 0.05 ? "ok" : "bad"
  );
  // The entire point of `still`: the body must not move, at all.
  log(`still preset: body sway ${swayAbs.toFixed(5)} (must be exactly 0)`, swayAbs === 0 ? "ok" : "bad");

  // Determinism: the whole design rests on this.
  const a = renderer.poseAt(2.5),
    b = renderer.poseAt(2.5);
  const same = JSON.stringify(a) === JSON.stringify(b);
  log(`determinism: poseAt(2.5) reproducible → ${same}`, same ? "ok" : "bad");

  /* --- Frames ------------------------------------------------------- */
  log("rendering frames…");
  const tRender = performance.now();
  for (let i = 0; i < 60; i++) renderer.renderFrame(ctx, (i / 60) * DURATION);
  const perFrame = (performance.now() - tRender) / 60;
  log(
    `render: ${perFrame.toFixed(2)}ms/frame at ${W}x${H} (${(1000 / perFrame).toFixed(0)}fps headroom)`,
    perFrame < 16 ? "ok" : "warn"
  );

  // Confirm we're not painting an empty canvas.
  renderer.renderFrame(ctx, DURATION * 0.45);
  const px = ctx.getImageData(0, 0, W, H).data;
  let lit = 0;
  for (let i = 0; i < px.length; i += 4 * 97) if (px[i] + px[i + 1] + px[i + 2] > 30) lit++;
  log(`frame content: ${((lit / (px.length / (4 * 97))) * 100).toFixed(0)}% non-black`, lit > 0 ? "ok" : "bad");

  /* --- Export ------------------------------------------------------- */
  log("exporting MP4…");
  const expCanvas = document.createElement("canvas");
  expCanvas.width = 1080;
  expCanvas.height = 1920;
  const expCtx = expCanvas.getContext("2d")!;
  const expRenderer = new FrameRenderer({
    layers,
    anchors,
    words: makeWords(DURATION),
    envelope,
    rigConfig: PRESETS.still,
    captions: DEFAULT_CAPTIONS,
    background: { ...DEFAULT_BACKGROUND, id: "blur" },
    durationSec: DURATION,
    width: 1080,
    height: 1920,
  });

  const tExp = performance.now();
  const result = await exportVideo({
    renderer: expRenderer,
    canvas: expCanvas,
    ctx: expCtx,
    audioBlob,
    durationSec: DURATION,
    config: { format: "mp4", width: 1080, height: 1920, fps: 30, bitrate: 8_000_000 },
    onProgress: (p) => {
      (logEl.lastElementChild as HTMLElement).textContent =
        `exporting: ${p.stage} ${(p.fraction * 100).toFixed(0)}% (${p.framesDone}/${p.framesTotal})`;
    },
  });
  const elapsed = (performance.now() - tExp) / 1000;

  log(
    `export: ${(result.blob.size / 1024 / 1024).toFixed(2)}MB ${result.mimeType} in ${elapsed.toFixed(1)}s (${(DURATION / elapsed).toFixed(1)}x realtime)`,
    result.blob.size > 10000 ? "ok" : "bad"
  );

  // Verify it's a real MP4: bytes 4..8 of an ISOBMFF file are 'ftyp'.
  const head = new Uint8Array(await result.blob.slice(0, 12).arrayBuffer());
  const brand = String.fromCharCode(...head.slice(4, 8));
  log(
    `container: box type "${brand}" ${brand === "ftyp" ? "(valid ISOBMFF/MP4)" : "(UNEXPECTED)"}`,
    brand === "ftyp" ? "ok" : "bad"
  );

  expRenderer.dispose();
  log("\nDONE", "ok");

  // Exposed so the ghosting check can be driven interactively: the artifact
  // only shows when the layers separate, which needs a high-parallax preset.
  Object.assign(window, {
    __result: result.blob,
    __renderer: renderer,
    __ctx: ctx,
    __presets: PRESETS,
    __duration: DURATION,
  });
}

main().catch((err) => {
  log(`\nFAILED: ${err?.message ?? err}`, "bad");
  console.error(err);
});
