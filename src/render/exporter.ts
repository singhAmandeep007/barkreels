/**
 * Offline video export.
 *
 * The old approach here was to play the audio, record the canvas with
 * MediaRecorder, and hope. That caps you at 1x speed, drops frames whenever
 * the tab loses focus or the compositor gets busy, and can only emit WebM.
 *
 * This exporter instead *steps* time forward in fixed 1/fps increments,
 * calling `renderFrame(t)` for each one and handing the result to a WebCodecs
 * VideoEncoder via Mediabunny. Nothing is real-time, so:
 *
 *   - every frame lands, always, at exactly the timestamp it claims
 *   - export usually runs several times faster than playback
 *   - backgrounding the tab slows it down but cannot corrupt it
 *   - we get real H.264 in a real MP4 container
 *
 * Audio is decoded once and handed over as an AudioBuffer; Mediabunny encodes
 * it to AAC and muxes both tracks.
 *
 * MediaRecorder survives only as a fallback for browsers without WebCodecs.
 */

import {
  Output,
  Mp4OutputFormat,
  WebMOutputFormat,
  BufferTarget,
  CanvasSource,
  AudioBufferSource,
  getFirstEncodableVideoCodec,
  getFirstEncodableAudioCodec,
  QUALITY_HIGH,
  type VideoCodec,
  type AudioCodec,
} from "mediabunny";

import type { ExportConfig } from "../types";
import type { FrameRenderer } from "./glRenderer";
import { decodeToPcm } from "../services/audioAnalysis";

export interface ExportProgress {
  /** 0..1 */
  fraction: number;
  stage: "preparing" | "encoding" | "finalizing";
  /** Frames rendered so far, for a "413 / 900" style readout. */
  framesDone: number;
  framesTotal: number;
}

export interface ExportRequest {
  renderer: FrameRenderer;
  /** The 2D canvas `renderFrame` draws into; also what we encode. */
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  audioBlob: Blob | null;
  durationSec: number;
  config: ExportConfig;
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  extension: string;
  mimeType: string;
}

export function isWebCodecsSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.VideoEncoder === "function" &&
    typeof window.VideoFrame === "function"
  );
}

/**
 * Codec preference order.
 *
 * AVC first: it's the only thing that reliably plays everywhere a social
 * platform might touch it. VP9/AV1 are better codecs but Instagram, iMessage
 * and a depressing number of desktop players still choke on them in an MP4.
 */
const MP4_VIDEO_CODECS: VideoCodec[] = ["avc", "hevc", "av1", "vp9"];
const WEBM_VIDEO_CODECS: VideoCodec[] = ["vp9", "vp8", "av1"];
const MP4_AUDIO_CODECS: AudioCodec[] = ["aac"];
const WEBM_AUDIO_CODECS: AudioCodec[] = ["opus"];

/**
 * Yield to the event loop periodically.
 *
 * Without this the render loop monopolises the main thread and the browser
 * shows a frozen page with a dead progress bar - which is a worse experience
 * than a slightly slower export that stays responsive.
 */
function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function exportVideo(request: ExportRequest): Promise<ExportResult> {
  const { renderer, canvas, ctx, audioBlob, durationSec, config, onProgress, signal } = request;

  if (config.format === "webm" || !isWebCodecsSupported()) {
    if (!isWebCodecsSupported() && config.format === "mp4") {
      // Be honest rather than silently handing back a mislabelled file.
      console.warn("WebCodecs unavailable - falling back to WebM via MediaRecorder.");
      return exportWithMediaRecorder(request);
    }
    if (!isWebCodecsSupported()) return exportWithMediaRecorder(request);
  }

  const isMp4 = config.format === "mp4";
  const framesTotal = Math.max(1, Math.round(durationSec * config.fps));

  onProgress?.({ fraction: 0, stage: "preparing", framesDone: 0, framesTotal });

  /* --- Negotiate codecs against what this browser can actually do --- */
  const videoCodec = await getFirstEncodableVideoCodec(isMp4 ? MP4_VIDEO_CODECS : WEBM_VIDEO_CODECS, {
    width: config.width,
    height: config.height,
    quality: QUALITY_HIGH,
  });
  if (!videoCodec) {
    throw new Error("This browser cannot hardware-encode any supported video codec. Try Chrome or Edge.");
  }

  const audioBuffer = audioBlob ? await decodeToPcm(audioBlob) : null;

  const audioCodec = audioBuffer
    ? await getFirstEncodableAudioCodec(isMp4 ? MP4_AUDIO_CODECS : WEBM_AUDIO_CODECS, {
        numberOfChannels: audioBuffer.numberOfChannels,
        sampleRate: audioBuffer.sampleRate,
      })
    : null;

  /* --- Build the output ------------------------------------------- */
  const output = new Output({
    format: isMp4
      ? new Mp4OutputFormat({
          // Puts the moov atom at the front so the file starts playing before
          // it's fully downloaded. Every social platform expects this, and
          // without it your video looks broken in preview.
          fastStart: "in-memory",
        })
      : new WebMOutputFormat(),
    target: new BufferTarget(),
  });

  const videoSource = new CanvasSource(canvas, {
    codec: videoCodec,
    quality: QUALITY_HIGH,
    // 2s between key frames: seeking stays responsive without bloating size.
    keyFrameInterval: 2,
  });
  output.addVideoTrack(videoSource, { frameRate: config.fps });

  let audioSource: AudioBufferSource | null = null;
  if (audioBuffer && audioCodec) {
    audioSource = new AudioBufferSource({ codec: audioCodec, quality: QUALITY_HIGH });
    output.addAudioTrack(audioSource);
  }

  await output.start();

  /* --- Audio first: one shot, the encoder pipelines it in background --- */
  if (audioSource && audioBuffer) {
    await audioSource.add(audioBuffer);
    audioSource.close();
  }

  /* --- The frame loop ---------------------------------------------- *
   * This is the whole point of the pure-function contract: `t` is derived
   * from the frame index, never from a clock, so frame 417 is identical
   * whether it took 3ms or 300ms to produce.                            */
  const frameDuration = 1 / config.fps;
  let lastYield = performance.now();

  try {
    for (let frame = 0; frame < framesTotal; frame++) {
      if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

      const t = frame * frameDuration;
      renderer.renderFrame(ctx, t);

      // Awaiting `add` applies the encoder's backpressure. Skipping it lets
      // frames pile up in memory until the tab dies on a long clip.
      await videoSource.add(t, frameDuration);

      if (frame % 5 === 0) {
        onProgress?.({
          fraction: frame / framesTotal,
          stage: "encoding",
          framesDone: frame,
          framesTotal,
        });
      }

      // Hand the main thread back roughly every 100ms so the UI keeps painting.
      const now = performance.now();
      if (now - lastYield > 100) {
        await yieldToBrowser();
        lastYield = now;
      }
    }

    videoSource.close();

    onProgress?.({
      fraction: 1,
      stage: "finalizing",
      framesDone: framesTotal,
      framesTotal,
    });

    await output.finalize();
  } catch (err) {
    // Cancelling mid-encode leaves the muxer holding resources; without this
    // a cancelled export leaks an encoder until the page reloads.
    try {
      await output.cancel();
    } catch {
      /* already torn down */
    }
    throw err;
  }

  const buffer = output.target.buffer;
  if (!buffer) throw new Error("Export produced no data.");

  return {
    blob: new Blob([buffer], { type: output.format.mimeType }),
    extension: isMp4 ? "mp4" : "webm",
    mimeType: output.format.mimeType,
  };
}

/* ------------------------------------------------------------------ *
 * Fallback path
 * ------------------------------------------------------------------ */

/**
 * Real-time MediaRecorder capture, for browsers without WebCodecs.
 *
 * Kept deliberately simple. It runs at 1x, it can drop frames under load, and
 * it only makes WebM - all the reasons the primary path exists. But a working
 * WebM beats an error dialog for the handful of users who land here.
 */
async function exportWithMediaRecorder(request: ExportRequest): Promise<ExportResult> {
  const { renderer, canvas, ctx, audioBlob, durationSec, config, onProgress, signal } = request;

  const framesTotal = Math.max(1, Math.round(durationSec * config.fps));
  onProgress?.({ fraction: 0, stage: "preparing", framesDone: 0, framesTotal });

  const stream = canvas.captureStream(config.fps);

  let audioContext: AudioContext | null = null;
  let audioEl: HTMLAudioElement | null = null;

  if (audioBlob) {
    audioEl = new Audio(URL.createObjectURL(audioBlob));
    audioEl.crossOrigin = "anonymous";
    await new Promise<void>((resolve, reject) => {
      audioEl!.oncanplaythrough = () => resolve();
      audioEl!.onerror = () => reject(new Error("Could not load audio for export."));
      audioEl!.load();
    });

    audioContext = new AudioContext();
    const source = audioContext.createMediaElementSource(audioEl);
    const destination = audioContext.createMediaStreamDestination();
    source.connect(destination);
    for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);
  }

  const mimeCandidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
  const mimeType = mimeCandidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "video/webm";

  const recorder = new MediaRecorder(stream, {
    mimeType,
    videoBitsPerSecond: config.bitrate,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data);
  };

  const done = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType }));
    recorder.onerror = () => reject(new Error("Recording failed."));
  });

  recorder.start();
  const startedAt = performance.now();
  if (audioEl) await audioEl.play();

  await new Promise<void>((resolve) => {
    const tick = () => {
      const elapsed = (performance.now() - startedAt) / 1000;

      if (signal?.aborted || elapsed >= durationSec) {
        resolve();
        return;
      }

      renderer.renderFrame(ctx, elapsed);
      onProgress?.({
        fraction: elapsed / durationSec,
        stage: "encoding",
        framesDone: Math.round(elapsed * config.fps),
        framesTotal,
      });
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });

  recorder.stop();
  for (const track of stream.getTracks()) track.stop();

  const blob = await done;

  audioEl?.pause();
  if (audioEl) URL.revokeObjectURL(audioEl.src);
  await audioContext?.close();

  if (signal?.aborted) throw new DOMException("Export cancelled", "AbortError");

  return { blob, extension: "webm", mimeType };
}

/* ------------------------------------------------------------------ *
 * Download
 * ------------------------------------------------------------------ */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoking synchronously can cancel the download in Safari; one turn of the
  // event loop is enough for the navigation to have been queued.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
