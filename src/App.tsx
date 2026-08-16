import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Settings, Sparkles, Dog, Mic, ArrowLeft, Film, Layers, Type, Info, Check } from "lucide-react";

import { SettingsModal } from "./components/SettingsModal";
import { DropZone } from "./components/DropZone";
import { DogInsights } from "./components/DogInsights";
import { VoicePanel } from "./components/VoicePanel";
import { StepIndicator } from "./components/StepIndicator";
import { StudioPreview } from "./components/StudioPreview";
import { RenderErrorBoundary } from "./components/RenderErrorBoundary";
import { StudioControls } from "./components/StudioControls";

import { analyzeDogImage, hasVisionConfig } from "./services/vision";
import { generateSpeech } from "./services/elevenlabs";
import { segmentImage, deriveAnchors, reconcileAnchors, preloadSegmenter } from "./services/segmentation";
import { analyzeAudio, getAudioDurationMs } from "./services/audioAnalysis";
import { PRESETS, applyEnergy } from "./render/rig";
import { extractAccentPalette } from "./render/accentColor";

import {
  DEFAULT_API_KEYS,
  DEFAULT_BACKGROUND,
  DEFAULT_CAPTIONS,
  DEFAULT_EXPORT,
  DEFAULT_VOICE,
  VOICE_MAP,
  type ApiKeys,
  type BackgroundConfig,
  type CaptionConfig,
  type ExportConfig,
  type RigConfig,
  type VoiceConfig,
  type VoiceSource,
  type WordTimestamp,
  type VideoProject,
} from "./types";

/**
 * State that survives a reload.
 *
 * `transient` names fields that must never be written to storage. This is not
 * an optimisation — it's a correctness requirement. Live objects like
 * `ImageBitmap` and blob: URLs serialise to `{}` and to dead strings, and both
 * come back *truthy but invalid*, which is far worse than coming back missing:
 * the app confidently hands `{}` to `drawImage` and throws inside canvas, with
 * a stack that points at the renderer rather than at the storage that caused
 * it. Stripping them on write means a reload degrades to the default instead.
 */
function useLocalStorage<T extends object>(
  key: string,
  initial: T,
  transient: (keyof T)[] = []
): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (!stored) return initial;
      // Merge rather than replace: a stored object written by an older build
      // may be missing fields this one requires.
      const parsed = { ...initial, ...JSON.parse(stored) };
      // Belt and braces for anything written by a build that lacked the strip.
      for (const field of transient) parsed[field] = initial[field];
      return parsed;
    } catch {
      return initial;
    }
  });

  const update = useCallback(
    (next: T) => {
      setValue(next);
      try {
        const persistable = { ...next };
        for (const field of transient) delete persistable[field];
        window.localStorage.setItem(key, JSON.stringify(persistable));
      } catch {
        /* quota or private mode - the app still works, it just won't persist */
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [key]
  );

  return [value, update];
}

const emptyProject = (): VideoProject => ({
  id: crypto.randomUUID(),
  imageFiles: [],
  imageUrls: [],
  activeImageIndex: 0,
  layers: null,
  analysis: null,
  ttsResult: null,
  envelope: null,
  status: "idle",
  error: null,
  usedOwnRecording: false,
});

export default function App() {
  const [apiKeys, setApiKeys] = useLocalStorage<ApiKeys>("barkreels-api-keys", DEFAULT_API_KEYS);
  const [captions, setCaptions] = useLocalStorage<CaptionConfig>("barkreels-captions", DEFAULT_CAPTIONS);
  // customImage is an ImageBitmap and customUrl is a blob: URL — neither
  // survives a reload, so neither may be written to storage.
  const [background, setBackground] = useLocalStorage<BackgroundConfig>(
    "barkreels-background",
    DEFAULT_BACKGROUND,
    ["customImage", "customUrl"]
  );
  const [exportConfig, setExportConfig] = useLocalStorage<ExportConfig>("barkreels-export", DEFAULT_EXPORT);

  // `still` is the default: for a portrait photo it's the most convincing
  // result, and it's the one style that can't look like a photo being waved
  // around. Users who want motion go looking for it.
  const [rigConfig, setRigConfig] = useState<RigConfig>(PRESETS.still);
  const [voice, setVoice] = useState<VoiceConfig>(DEFAULT_VOICE);
  const [showSettings, setShowSettings] = useState(false);
  const [project, setProject] = useState<VideoProject>(emptyProject);
  const [segmentLabel, setSegmentLabel] = useState("");
  const [segmentFraction, setSegmentFraction] = useState(0);

  const keysReady = !!apiKeys.elevenLabsKey && hasVisionConfig(apiKeys);

  /* --- Warm the segmentation model in the background ----------------- *
   * The weights are ~22MB. Fetching them the moment a photo lands means
   * that download overlaps with the user reading the analysis card and
   * the vision API round trip, instead of being 20 seconds of dead air
   * after they hit the button.                                          */
  useEffect(() => {
    if (project.imageUrls.length === 0) return;
    void preloadSegmenter();
  }, [project.imageUrls.length]);

  /* --- Object URL hygiene ------------------------------------------- *
   * Blob URLs are never reclaimed by the GC on their own; without this a
   * user swapping through a dozen photos leaks every one of them.        */
  useEffect(() => {
    const urls = project.imageUrls;
    return () => {
      for (const url of urls) URL.revokeObjectURL(url);
    };
  }, [project.imageUrls]);

  const currentStep = useMemo(() => {
    if (project.imageUrls.length === 0) return 0;
    if (!project.analysis) return 1;
    if (!project.ttsResult) return 2;
    return 3;
  }, [project]);

  const completedSteps = useMemo(() => {
    const done: number[] = [];
    if (project.imageUrls.length > 0) done.push(0);
    if (project.analysis) done.push(1);
    if (project.ttsResult) done.push(2);
    if (project.status === "done") done.push(3);
    return done;
  }, [project]);

  /* --- Upload -------------------------------------------------------- */
  const handleImageSelect = useCallback((files: File[]) => {
    if (files.length === 0) return;
    setProject({
      ...emptyProject(),
      imageFiles: files,
      imageUrls: files.map((f) => URL.createObjectURL(f)),
    });
  }, []);

  const handleReset = useCallback(() => setProject(emptyProject()), []);

  /* --- Analyse + segment --------------------------------------------- *
   * Run together: both read the same photo, and the user thinks of them
   * as one "figure out my dog" step rather than two.                     */
  const handleAnalyze = useCallback(async () => {
    const file = project.imageFiles[project.activeImageIndex];
    if (!file) return;

    if (!hasVisionConfig(apiKeys)) {
      setShowSettings(true);
      return;
    }

    setProject((prev) => ({ ...prev, status: "analyzing", error: null }));

    try {
      // The vision call is network-bound and segmentation is compute-bound, so
      // they overlap almost perfectly - running them concurrently costs about
      // as long as the slower one alone.
      const [analysis, layers] = await Promise.all([
        // Only ask the model to write when the user wants it to. If they're
        // supplying a script or a recording, those fields are dead weight.
        analyzeDogImage(file, apiKeys, voice.source === "persona"),
        (async () => {
          setProject((prev) => ({ ...prev, status: "segmenting" }));
          return segmentImage(file, (p) => {
            setSegmentFraction(p.fraction);
            setSegmentLabel(p.label);
          });
        })(),
      ]);

      setSegmentLabel("");
      setSegmentFraction(0);

      setRigConfig((prev) => applyEnergy(prev, analysis.energy));

      setProject((prev) => ({
        ...prev,
        analysis,
        layers,
        status: "idle",
      }));
    } catch (err) {
      setSegmentLabel("");
      setProject((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : "Analysis failed.",
      }));
    }
  }, [project.imageFiles, project.activeImageIndex, apiKeys, voice.source]);

  /* --- Voice ---------------------------------------------------------- *
   * Three paths converge on the same shape: an audio blob, a duration, an
   * envelope, and (only for TTS) word timestamps. Everything downstream
   * reads that shape and never asks where the audio came from.            */
  const handleGenerateVoice = useCallback(async () => {
    setProject((prev) => ({ ...prev, status: "generating-voice", error: null }));

    try {
      let audioBlob: Blob;
      let audioUrl: string;
      let wordTimestamps: WordTimestamp[] = [];

      if (voice.source === "record") {
        // The recording is the voiceover. ElevenLabs is not involved at all,
        // which also means there are no word timings and so no subtitles.
        if (!voice.recording) throw new Error("Record or upload some audio first.");
        audioBlob = voice.recording;
        audioUrl = voice.recordingUrl || URL.createObjectURL(voice.recording);
      } else {
        if (!apiKeys.elevenLabsKey) {
          setShowSettings(true);
          setProject((prev) => ({ ...prev, status: "idle" }));
          return;
        }
        const script = voice.script.trim();
        if (!script) throw new Error("Write something for your dog to say first.");

        const tts = await generateSpeech(script, VOICE_MAP[voice.persona], apiKeys.elevenLabsKey);
        audioBlob = tts.audioBlob;
        audioUrl = tts.audioUrl;
        wordTimestamps = tts.wordTimestamps;
      }

      // Word timestamps stop at the last syllable, and a recording has none at
      // all, so the decoded duration is the only reliable length. Without it
      // the export truncates the tail.
      const [envelope, durationMs] = await Promise.all([analyzeAudio(audioBlob), getAudioDurationMs(audioBlob)]);

      setProject((prev) => ({
        ...prev,
        ttsResult: { audioBlob, audioUrl, wordTimestamps, durationMs },
        envelope,
        usedOwnRecording: voice.source === "record",
        status: "previewing",
      }));
    } catch (err) {
      setProject((prev) => ({
        ...prev,
        status: "error",
        error: err instanceof Error ? err.message : "Voice generation failed.",
      }));
    }
  }, [voice, apiKeys.elevenLabsKey]);

  const handleExported = useCallback(() => {
    setProject((prev) => ({ ...prev, status: "done" }));
  }, []);

  const anchors = useMemo(() => {
    if (!project.layers) return null;
    return reconcileAnchors(project.analysis?.anchors ?? null, deriveAnchors(project.layers.cutoutBox));
  }, [project.layers, project.analysis]);

  const isAnalyzing = project.status === "analyzing" || project.status === "segmenting";
  const isGeneratingVoice = project.status === "generating-voice";
  /* --- Caption colour sampled from the photo -------------------------- *
   * Derived from the cutout so the background can't vote. Saturation is
   * weighted heavily, which is what lets a small pink collar beat a large
   * beige body.                                                            */
  const accent = useMemo(() => {
    if (!project.layers) return null;
    return extractAccentPalette(project.layers.source, project.layers.cutout, project.layers.cutoutBox);
  }, [project.layers]);

  // Adopt the sampled colour once per photo, but never stomp on a colour the
  // user picked themselves.
  const appliedAccentFor = useRef<string | null>(null);
  useEffect(() => {
    if (!accent || appliedAccentFor.current === project.id) return;
    appliedAccentFor.current = project.id;
    setCaptions({ ...captions, highlightColor: accent.highlight });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accent, project.id]);

  // Subtitles require per-word timings, which only TTS produces.
  const captionsAvailable = (project.ttsResult?.wordTimestamps.length ?? 0) > 0;

  const readyToRender = !!(project.ttsResult && project.layers && anchors && project.analysis);

  const fileLabel = useMemo(() => {
    const breed = project.analysis?.breed?.replace(/\s+/g, "-").toLowerCase() ?? "dog";
    return `barkreels-${breed}-${Date.now()}`;
  }, [project.analysis]);

  return (
    <div className="min-h-screen bg-[#030712] noise-bg">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-40 -right-40 w-96 h-96 bg-amber-500/10 rounded-full blur-[140px]" />
        <div className="absolute -bottom-40 -left-40 w-[30rem] h-[30rem] bg-rose-500/10 rounded-full blur-[140px]" />
      </div>

      <header className="relative z-50 border-b border-white/5 bg-[#030712]/80 backdrop-blur-xl sticky top-0">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-rose-500 flex items-center justify-center shadow-lg shadow-amber-500/20">
              <Dog className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-bold gradient-text">BarkReels</h1>
              <p className="text-[10px] text-gray-500 uppercase tracking-widest font-black">AI Dog Monologues</p>
            </div>
          </div>

          <button
            onClick={() => setShowSettings(true)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-all duration-300 border ${
              keysReady
                ? "bg-gray-900/40 text-gray-300 hover:bg-gray-900 hover:text-white border-white/5"
                : "bg-gradient-to-r from-amber-500 to-rose-500 text-white border-transparent shadow-lg shadow-orange-500/20 animate-pulse-glow"
            }`}
          >
            <Settings className="h-4 w-4" />
            {keysReady ? "API settings" : "Set API keys"}
          </button>
        </div>
      </header>

      <main className="relative z-10 max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        {project.error && (
          <div className="max-w-2xl mx-auto mb-8 animate-slide-up">
            <div className="bg-red-500/10 border border-red-500/20 rounded-2xl p-4 text-red-400 text-sm">
              <p className="font-bold mb-1">⚠️ Something went wrong</p>
              <p className="text-red-400/80">{project.error}</p>
            </div>
          </div>
        )}

        {project.imageUrls.length === 0 ? (
          <Landing onImageSelect={handleImageSelect} />
        ) : (
          <div className="space-y-10">
            <StepIndicator
              currentStep={currentStep}
              completedSteps={completedSteps}
            />

            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
              {/* Left: source + script */}
              <div className="lg:col-span-4 space-y-6">
                <DropZone
                  onImageSelect={handleImageSelect}
                  currentImage={project.imageUrls[project.activeImageIndex] ?? null}
                />

                {project.imageUrls.length > 1 && (
                  <div className="flex gap-2 flex-wrap justify-center">
                    {project.imageUrls.map((url, i) => (
                      <button
                        key={url}
                        onClick={() => setProject((prev) => ({ ...prev, activeImageIndex: i }))}
                        className={`h-14 w-14 rounded-xl overflow-hidden border-2 transition-all ${
                          i === project.activeImageIndex
                            ? "border-amber-500 scale-105"
                            : "border-white/10 opacity-60 hover:opacity-100"
                        }`}
                      >
                        <img
                          src={url}
                          alt={`Angle ${i + 1}`}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}

                <button
                  onClick={handleReset}
                  className="flex items-center gap-1.5 text-xs font-bold text-gray-500 hover:text-white transition-colors mx-auto"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Start over
                </button>

                {project.analysis && <DogInsights analysis={project.analysis} />}
              </div>

              {/* Middle: the action panel */}
              <div className="lg:col-span-4 space-y-6">
                {!project.analysis ? (
                  <div className="space-y-5">
                    <VoiceSourceChooser
                      value={voice.source}
                      onChange={(source) => setVoice({ ...voice, source })}
                    />
                    <ActionCard
                      icon={<Sparkles className="h-5 w-5 text-amber-500" />}
                      title="Analyse the photo"
                      body={
                        voice.source === "persona"
                          ? "The model locates the nose, mouth, eyes and ears, and writes a monologue. Those coordinates are what the mouth animation deforms."
                          : "The model locates the nose, mouth, eyes and ears. Those coordinates are what the mouth animation deforms - it won't write anything, since you're supplying the words."
                      }
                      ctaLabel="Start analysis"
                      busyLabel={
                        project.status === "segmenting"
                          ? segmentLabel || "Isolating your dog…"
                          : "Reading the portrait…"
                      }
                      busy={isAnalyzing}
                      progress={project.status === "segmenting" ? segmentFraction : undefined}
                      ready={keysReady}
                      onOpenSettings={() => setShowSettings(true)}
                      onAction={handleAnalyze}
                    />
                  </div>
                ) : !project.ttsResult ? (
                  <VoicePanel
                    analysis={project.analysis}
                    voice={voice}
                    onChange={setVoice}
                    onGenerate={handleGenerateVoice}
                    busy={isGeneratingVoice}
                    busyLabel="Synthesising…"
                    // A recording needs no ElevenLabs key at all, so don't
                    // gate that path behind one.
                    ready={voice.source === "record" ? true : keysReady}
                    onOpenSettings={() => setShowSettings(true)}
                  />
                ) : (
                  <StudioControls
                    rigConfig={rigConfig}
                    onRigChange={setRigConfig}
                    captions={captions}
                    onCaptionsChange={setCaptions}
                    captionsAvailable={captionsAvailable}
                    accentSwatches={accent?.swatches ?? []}
                    background={background}
                    onBackgroundChange={setBackground}
                    exportConfig={exportConfig}
                    onExportChange={setExportConfig}
                  />
                )}
              </div>

              {/* Right: the reel */}
              <div className="lg:col-span-4 w-full lg:sticky lg:top-24">
                {readyToRender ? (
                  <RenderErrorBoundary resetKey={project.id}>
                    <StudioPreview
                      layers={project.layers!}
                      anchors={anchors!}
                      words={project.ttsResult!.wordTimestamps}
                      envelope={project.envelope}
                      audioBlob={project.ttsResult!.audioBlob}
                      audioUrl={project.ttsResult!.audioUrl}
                      durationSec={project.ttsResult!.durationMs / 1000}
                      rigConfig={rigConfig}
                      captions={captionsAvailable ? captions : { ...captions, enabled: false }}
                      background={background}
                      exportConfig={exportConfig}
                      fileLabel={fileLabel}
                      onExported={handleExported}
                    />
                  </RenderErrorBoundary>
                ) : null}
              </div>
            </div>
          </div>
        )}

        <footer className="mt-24 pb-8 text-center border-t border-white/5 pt-8">
          <p className="text-gray-600 text-xs font-semibold">
            Made by{" "}
            <a
              href="https://singhamandeep007.github.io/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-500 hover:text-amber-400 underline"
            >
              Amandeep Singh
            </a>{" "}
            for{" "}
            <a
              href="https://dev.to/challenges/weekend-2026-08-13"
              target="_blank"
              rel="noopener noreferrer"
              className="text-amber-500 hover:text-amber-400 underline"
            >
              DEV Weekend Challenge: Dog Days Edition
            </a>
          </p>
          <div className="flex items-center justify-center gap-3 text-[10px] text-gray-700 font-black uppercase mt-2.5 tracking-wider">
            <span>Gemini / Ollama</span>
            <span>•</span>
            <span>ElevenLabs</span>
            <span>•</span>
            <span>WebGL + WebCodecs</span>
          </div>
        </footer>
      </main>

      <SettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        apiKeys={apiKeys}
        onSave={setApiKeys}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Local presentational pieces
 * ------------------------------------------------------------------ */

function ActionCard({
  icon,
  title,
  body,
  ctaLabel,
  busyLabel,
  busy,
  ready,
  progress,
  onAction,
  onOpenSettings,
}: {
  icon: React.ReactNode;
  title: string;
  body: string;
  ctaLabel: string;
  busyLabel: string;
  busy: boolean;
  ready: boolean;
  progress?: number;
  onAction: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <div className="glass-card p-8 rounded-3xl space-y-5 relative overflow-hidden">
      <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl pointer-events-none" />

      <h3 className="text-xl font-black text-white flex items-center gap-2">
        {icon}
        {title}
      </h3>
      <p className="text-gray-400 text-sm leading-relaxed">{body}</p>

      <div className="pt-4 border-t border-white/5 space-y-3">
        {!ready ? (
          <>
            <p className="text-xs text-rose-400 font-semibold">Add your API keys to continue.</p>
            <button
              onClick={onOpenSettings}
              className="gradient-btn w-full"
            >
              Set API keys
            </button>
          </>
        ) : (
          <>
            <button
              onClick={onAction}
              disabled={busy}
              className="gradient-btn w-full py-4"
            >
              <span className="flex items-center justify-center gap-2">
                {busy ? (
                  <>
                    <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                    {busyLabel}
                  </>
                ) : (
                  ctaLabel
                )}
              </span>
            </button>

            {busy && progress !== undefined && progress > 0 && (
              <div className="h-1.5 w-full bg-gray-900 rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-amber-500 to-rose-500 transition-all duration-200"
                  style={{ width: `${progress * 100}%` }}
                />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Landing({ onImageSelect }: { onImageSelect: (files: File[]) => void }) {
  const features = [
    {
      icon: <Sparkles className="h-5 w-5 text-amber-500" />,
      title: "Vision analysis",
      body: "Breed, mood, a monologue, and the exact coordinates of the muzzle and eyes.",
    },
    {
      icon: <Mic className="h-5 w-5 text-orange-500" />,
      title: "ElevenLabs voice",
      body: "Word-level timestamps drive the subtitles; the loudness envelope drives the jaw.",
    },
    {
      icon: <Layers className="h-5 w-5 text-rose-500" />,
      title: "Real depth",
      body: "Your dog is segmented from the background, so the two can move independently.",
    },
    {
      icon: <Film className="h-5 w-5 text-purple-500" />,
      title: "MP4 in the browser",
      body: "WebGL renders every frame offline, WebCodecs encodes H.264. No server, ever.",
    },
  ];

  return (
    <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-center py-4 animate-fade-in max-w-6xl mx-auto">
      <div className="lg:col-span-7 space-y-8">
        <div className="space-y-4">
          <h2 className="text-5xl lg:text-7xl font-black text-white leading-none tracking-tight">
            Give your dog <br />
            <span className="gradient-text">a voice</span> 🐕
          </h2>
          <p className="text-gray-400 text-lg leading-relaxed max-w-xl">
            Upload a photo. Get a talking, breathing, blinking reel with subtitles and a real MP4 at the end - rendered
            entirely in your browser.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-4">
          {features.map((f) => (
            <div
              key={f.title}
              className="glass-card p-5 rounded-2xl border-white/5 space-y-2 hover:-translate-y-0.5 transition-transform duration-300"
            >
              <div className="w-10 h-10 rounded-xl bg-white/5 flex items-center justify-center border border-white/10 mb-1">
                {f.icon}
              </div>
              <h4 className="text-sm font-bold text-white">{f.title}</h4>
              <p className="text-gray-500 text-xs leading-normal">{f.body}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="lg:col-span-5 w-full space-y-4">
        <DropZone
          onImageSelect={onImageSelect}
          currentImage={null}
        />
        <PhotoGuidance />
      </div>
    </div>
  );
}

/**
 * Asked *before* analysis, deliberately.
 *
 * The vision call is where "write me a monologue" gets requested, so the
 * choice has to exist by then. Asking afterwards would mean either always
 * generating a monologue the user may not want, or making a second call.
 */
function VoiceSourceChooser({ value, onChange }: { value: VoiceSource; onChange: (source: VoiceSource) => void }) {
  const options: { id: VoiceSource; label: string; desc: string; icon: React.ReactNode }[] = [
    {
      id: "persona",
      label: "Let the AI write it",
      desc: "It invents a monologue from the photo, then speaks it",
      icon: <Sparkles className="h-4 w-4" />,
    },
    {
      id: "text",
      label: "I'll write the words",
      desc: "Your script in any language, spoken in a voice you pick",
      icon: <Type className="h-4 w-4" />,
    },
    {
      id: "record",
      label: "I'll use my own voice",
      desc: "Your recording, embedded as-is. No subtitles",
      icon: <Mic className="h-4 w-4" />,
    },
  ];

  return (
    <div className="glass-card p-6 rounded-3xl space-y-4">
      <div>
        <h3 className="text-lg font-black text-white">Where do the words come from?</h3>
      </div>

      <div className="space-y-2">
        {options.map((o) => {
          const active = value === o.id;
          return (
            <button
              key={o.id}
              onClick={() => onChange(o.id)}
              className={`w-full flex items-start gap-3 p-3.5 rounded-xl border text-left transition-all ${
                active
                  ? "bg-gradient-to-r from-amber-500/10 to-rose-500/10 border-amber-500/50"
                  : "bg-gray-950/40 border-white/5 hover:border-gray-700"
              }`}
            >
              <span className={`mt-0.5 ${active ? "text-amber-500" : "text-gray-500"}`}>{o.icon}</span>
              <div className="min-w-0">
                <span className="block text-xs font-bold text-white">{o.label}</span>
                <span className="block text-[10px] text-gray-500 mt-0.5">{o.desc}</span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * What actually works, stated plainly.
 *
 * Every failure mode here is a real one: the rig deforms specific anchors, so
 * a photo where those anchors aren't visible produces a dog whose face ripples
 * in the wrong place. Saying so up front is cheaper than debugging it later.
 */
function PhotoGuidance() {
  const rules = [
    ["Head-on portrait", "Facing the camera. Profile shots hide one eye and one ear."],
    ["Face fills the frame", "Head and shoulders. Full-body shots leave the muzzle too small to animate."],
    ["Eyes, nose, mouth and ears clearly visible", "These are the exact points the animation moves."],
    ["One dog", "Segmentation keeps a single subject; two dogs become one blob."],
    ["Sharp and well lit", "Blur and deep shadow make the cutout edge mushy."],
    ["No sunglasses, hands or toys over the face", "Anything covering an anchor gets deformed along with it."],
  ];

  return (
    <div className="glass-card p-5 rounded-2xl space-y-3">
      <h4 className="text-xs font-black text-white uppercase tracking-wide flex items-center gap-2">
        <Info className="h-3.5 w-3.5 text-amber-500" />
        What works best
      </h4>
      <ul className="space-y-2">
        {rules.map(([title, why]) => (
          <li
            key={title}
            className="flex gap-2 text-[11px] leading-relaxed"
          >
            <Check className="h-3.5 w-3.5 text-emerald-500 shrink-0 mt-px" />
            <span>
              <span className="text-gray-300 font-semibold">{title}</span>
              <span className="text-gray-500"> - {why}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
