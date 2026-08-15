import { useCallback, useEffect, useRef, useState } from "react";
import { Play, Pause, Download, RotateCcw, Volume2, X } from "lucide-react";
import type {
  AudioEnvelope,
  BackgroundConfig,
  CaptionConfig,
  DogAnchors,
  ExportConfig,
  LayerSet,
  RigConfig,
  WordTimestamp,
} from "../types";
import { FrameRenderer } from "../render/glRenderer";
import { exportVideo, downloadBlob, isWebCodecsSupported } from "../render/exporter";

/**
 * Preview renders at half resolution. The rig is resolution-independent, so a
 * 540x960 preview is a faithful preview of a 1080x1920 export - it just costs
 * a quarter of the fill rate, which keeps the preview at a solid 60fps even on
 * integrated graphics.
 */
const PREVIEW_WIDTH = 540;
const PREVIEW_HEIGHT = 960;

interface StudioPreviewProps {
  layers: LayerSet;
  anchors: DogAnchors;
  words: WordTimestamp[];
  envelope: AudioEnvelope | null;
  audioBlob: Blob | null;
  audioUrl: string;
  durationSec: number;
  rigConfig: RigConfig;
  captions: CaptionConfig;
  background: BackgroundConfig;
  exportConfig: ExportConfig;
  fileLabel: string;
  onExported?: () => void;
}

export function StudioPreview({
  layers,
  anchors,
  words,
  envelope,
  audioBlob,
  audioUrl,
  durationSec,
  rigConfig,
  captions,
  background,
  exportConfig,
  fileLabel,
  onExported,
}: StudioPreviewProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<FrameRenderer | null>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [isExporting, setIsExporting] = useState(false);
  const [exportLabel, setExportLabel] = useState("");
  const [exportFraction, setExportFraction] = useState(0);
  const [error, setError] = useState<string | null>(null);

  /* --- Build the renderer once per source change -------------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = PREVIEW_WIDTH;
    canvas.height = PREVIEW_HEIGHT;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctxRef.current = ctx;

    let renderer: FrameRenderer;
    try {
      renderer = new FrameRenderer({
        layers,
        anchors,
        words,
        envelope,
        rigConfig,
        captions,
        background,
        durationSec,
        width: PREVIEW_WIDTH,
        height: PREVIEW_HEIGHT,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the renderer.");
      return;
    }

    rendererRef.current = renderer;
    renderer.renderFrame(ctx, 0);

    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
    // Only the heavyweight inputs rebuild the renderer; the cheap knobs are
    // pushed through `update` below so tweaking a slider doesn't recompile
    // shaders and re-upload textures.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layers, durationSec]);

  /* --- Push cheap config changes without a rebuild ------------------ */
  useEffect(() => {
    const renderer = rendererRef.current;
    const ctx = ctxRef.current;
    if (!renderer || !ctx) return;

    renderer.update({ anchors, words, envelope, rigConfig, captions, background });

    // Repaint immediately so paused edits are visible - otherwise changing the
    // caption colour appears to do nothing until you hit play.
    if (!isPlaying) renderer.renderFrame(ctx, currentTime);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchors, words, envelope, rigConfig, captions, background]);

  /* --- Audio element ------------------------------------------------ */
  useEffect(() => {
    const audio = new Audio(audioUrl);
    audio.preload = "auto";
    audioRef.current = audio;

    const onEnded = () => setIsPlaying(false);
    audio.addEventListener("ended", onEnded);

    return () => {
      audio.removeEventListener("ended", onEnded);
      audio.pause();
      audioRef.current = null;
    };
  }, [audioUrl]);

  /* --- The preview loop --------------------------------------------- *
   * Time comes from the audio element, which is the one authority on
   * playback position. The renderer itself stays pure - it's told what
   * time it is rather than working it out.                              */
  useEffect(() => {
    if (!isPlaying) return;

    const tick = () => {
      const audio = audioRef.current;
      const renderer = rendererRef.current;
      const ctx = ctxRef.current;
      if (!audio || !renderer || !ctx) return;

      const t = audio.currentTime;
      setCurrentTime(t);
      renderer.renderFrame(ctx, t);

      if (!audio.paused && !audio.ended) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        setIsPlaying(false);
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [isPlaying]);

  const togglePlay = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;

    if (isPlaying) {
      audio.pause();
      setIsPlaying(false);
    } else {
      if (audio.ended || audio.currentTime >= durationSec - 0.05) audio.currentTime = 0;
      try {
        await audio.play();
        setIsPlaying(true);
      } catch {
        setError("Playback was blocked. Click the preview once, then press play.");
      }
    }
  }, [isPlaying, durationSec]);

  const seek = useCallback(
    (t: number) => {
      const audio = audioRef.current;
      const renderer = rendererRef.current;
      const ctx = ctxRef.current;
      if (!audio || !renderer || !ctx) return;

      const clamped = Math.max(0, Math.min(durationSec, t));
      audio.currentTime = clamped;
      setCurrentTime(clamped);
      if (!isPlaying) renderer.renderFrame(ctx, clamped);
    },
    [durationSec, isPlaying]
  );

  const restart = useCallback(() => seek(0), [seek]);

  /* --- Export -------------------------------------------------------- */
  const handleExport = useCallback(async () => {
    if (isExporting) return;

    const audio = audioRef.current;
    audio?.pause();
    setIsPlaying(false);
    setError(null);
    setIsExporting(true);
    setExportFraction(0);
    setExportLabel("Preparing…");

    const controller = new AbortController();
    abortRef.current = controller;

    // A dedicated full-resolution renderer and canvas. The preview's own
    // 540x960 pair keeps running the UI; exporting through it would hand the
    // user a half-size video.
    const exportCanvas = document.createElement("canvas");
    exportCanvas.width = exportConfig.width;
    exportCanvas.height = exportConfig.height;
    const exportCtx = exportCanvas.getContext("2d");

    let exportRenderer: FrameRenderer | null = null;

    try {
      if (!exportCtx) throw new Error("Could not create the export canvas.");

      exportRenderer = new FrameRenderer({
        layers,
        anchors,
        words,
        envelope,
        rigConfig,
        captions,
        background,
        durationSec,
        width: exportConfig.width,
        height: exportConfig.height,
      });

      const result = await exportVideo({
        renderer: exportRenderer,
        canvas: exportCanvas,
        ctx: exportCtx,
        audioBlob,
        durationSec,
        config: exportConfig,
        signal: controller.signal,
        onProgress: (p) => {
          setExportFraction(p.fraction);
          setExportLabel(
            p.stage === "encoding"
              ? `Encoding frame ${p.framesDone} of ${p.framesTotal}`
              : p.stage === "finalizing"
                ? "Writing the file…"
                : "Preparing…"
          );
        },
      });

      downloadBlob(result.blob, `${fileLabel}.${result.extension}`);
      onExported?.();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setError(null);
      } else {
        setError(err instanceof Error ? err.message : "Export failed.");
      }
    } finally {
      exportRenderer?.dispose();
      abortRef.current = null;
      setIsExporting(false);
      setExportFraction(0);
      setExportLabel("");
    }
  }, [
    isExporting,
    layers,
    anchors,
    words,
    envelope,
    rigConfig,
    captions,
    background,
    durationSec,
    exportConfig,
    audioBlob,
    fileLabel,
    onExported,
  ]);

  const cancelExport = useCallback(() => abortRef.current?.abort(), []);

  const progressPct = durationSec > 0 ? (currentTime / durationSec) * 100 : 0;

  return (
    <div className="w-full max-w-sm mx-auto space-y-6 animate-slide-up">
      {/* Phone frame */}
      <div className="relative group">
        <div className="bg-gray-900/90 p-3 rounded-[2.8rem] shadow-2xl border border-white/10 backdrop-blur-md">
          <div className="relative aspect-[9/16] bg-gray-950 rounded-[2.2rem] overflow-hidden">
            <canvas
              ref={canvasRef}
              className="w-full h-full object-cover"
            />

            <div className="absolute inset-0 bg-gradient-to-tr from-transparent via-white/5 to-transparent pointer-events-none z-20" />

            <div
              className="absolute inset-0 flex items-center justify-center cursor-pointer z-10"
              onClick={togglePlay}
            >
              <div className="w-16 h-16 rounded-full bg-black/50 backdrop-blur-lg flex items-center justify-center border border-white/20 text-white shadow-2xl opacity-0 group-hover:opacity-100 transition-all duration-300">
                {isPlaying ? <Pause className="h-8 w-8" /> : <Play className="h-8 w-8 ml-1" />}
              </div>
            </div>

            <div className="absolute top-3 left-1/2 -translate-x-1/2 w-24 h-4 bg-black rounded-full z-30" />

            {isPlaying && (
              <div className="absolute top-4 right-4 bg-black/50 backdrop-blur-md rounded-full p-2 border border-white/10 z-30">
                <Volume2 className="h-4 w-4 text-white" />
              </div>
            )}

            <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-white/10 z-30 pointer-events-none">
              <div
                className="h-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Transport */}
      <div className="glass-card p-4 rounded-2xl space-y-3">
        <div className="flex items-center gap-3">
          <button
            onClick={togglePlay}
            className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-amber-500 to-rose-500 text-white flex items-center justify-center shadow-lg shadow-orange-500/20 hover:scale-105 active:scale-95 transition-transform"
            aria-label={isPlaying ? "Pause" : "Play"}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>

          <button
            onClick={restart}
            className="h-10 w-10 shrink-0 rounded-xl bg-gray-900/60 border border-white/5 text-gray-300 hover:text-white flex items-center justify-center transition-colors"
            aria-label="Restart"
          >
            <RotateCcw className="h-4 w-4" />
          </button>

          <input
            type="range"
            min={0}
            max={durationSec}
            step={0.01}
            value={currentTime}
            onChange={(e) => seek(Number(e.target.value))}
            className="flex-1 accent-amber-500 cursor-pointer"
            aria-label="Scrub"
          />

          <span className="text-[11px] font-bold text-gray-500 tabular-nums shrink-0 w-16 text-right">
            {currentTime.toFixed(1)}s / {durationSec.toFixed(1)}s
          </span>
        </div>
      </div>

      {/* Export */}
      <div className="glass-card p-5 rounded-3xl space-y-4">
        {!isExporting ? (
          <button
            onClick={handleExport}
            className="w-full rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-6 py-4 text-white font-bold hover:scale-[1.02] active:scale-[0.98] transition-all duration-300 shadow-xl shadow-orange-500/20 flex items-center justify-center gap-2"
          >
            <Download className="h-5 w-5" />
            Export {exportConfig.format.toUpperCase()} · {exportConfig.height}p
          </button>
        ) : (
          <div className="space-y-3">
            <div className="flex justify-between items-center text-xs font-bold">
              <span className="text-gray-400">{exportLabel}</span>
              <span className="text-amber-500 tabular-nums">{Math.round(exportFraction * 100)}%</span>
            </div>
            <div className="h-2 w-full bg-gray-900 rounded-full overflow-hidden border border-white/5">
              <div
                className="h-full bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 transition-all duration-200 ease-out"
                style={{ width: `${exportFraction * 100}%` }}
              />
            </div>
            <button
              onClick={cancelExport}
              className="w-full flex items-center justify-center gap-1.5 text-xs font-bold text-gray-500 hover:text-rose-400 transition-colors"
            >
              <X className="h-3.5 w-3.5" />
              Cancel export
            </button>
          </div>
        )}

        {!isWebCodecsSupported() && (
          <p className="text-[11px] text-amber-500/80 leading-relaxed">
            This browser has no WebCodecs support, so exports fall back to real-time WebM recording. Chrome or Edge will
            give you a real MP4.
          </p>
        )}

        {error && <p className="text-[11px] text-rose-400 leading-relaxed">{error}</p>}
      </div>
    </div>
  );
}
