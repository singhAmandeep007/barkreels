import { useCallback, useEffect, useRef, useState } from "react";
import { Mic, Sparkles, Type, Square, Trash2, Upload, Play, Pause, Info } from "lucide-react";
import type { DogAnalysis, VoiceConfig, VoicePersonaId, VoiceSource } from "../types";

interface VoicePanelProps {
  analysis: DogAnalysis | null;
  voice: VoiceConfig;
  onChange: (voice: VoiceConfig) => void;
  onGenerate: () => void;
  busy: boolean;
  busyLabel: string;
  /** False when keys are missing — the panel offers settings instead. */
  ready: boolean;
  onOpenSettings: () => void;
}

const SOURCES: { id: VoiceSource; label: string; icon: React.ReactNode; desc: string }[] = [
  { id: "persona", label: "AI writes it", icon: <Sparkles className="h-4 w-4" />, desc: "Model writes the monologue" },
  { id: "text", label: "I'll write it", icon: <Type className="h-4 w-4" />, desc: "Your script, AI voice" },
  { id: "record", label: "My own voice", icon: <Mic className="h-4 w-4" />, desc: "Your recording, used as-is" },
];

const PERSONAS: { id: VoicePersonaId; label: string; emoji: string; desc: string }[] = [
  { id: "deep", label: "Deep & Wise", emoji: "🧙", desc: "Gravitas" },
  { id: "playful", label: "Playful Pup", emoji: "🎾", desc: "Energetic" },
  { id: "dramatic", label: "Dramatic", emoji: "🎭", desc: "Over the top" },
  { id: "sassy", label: "Sassy Diva", emoji: "💅", desc: "Posh" },
];

/** ElevenLabs bills per character, so an unbounded textarea is a real cost. */
const MAX_SCRIPT = 600;

export function VoicePanel({
  analysis, voice, onChange, onGenerate, busy, busyLabel, ready, onOpenSettings,
}: VoicePanelProps) {
  const set = <K extends keyof VoiceConfig>(key: K, value: VoiceConfig[K]) =>
    onChange({ ...voice, [key]: value });

  /**
   * Seed the editable script from the model's monologue once it arrives, but
   * never overwrite something the user has already typed.
   */
  useEffect(() => {
    if (analysis?.monologue && !voice.script) {
      onChange({ ...voice, script: analysis.monologue, persona: analysis.suggestedVoice });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [analysis?.monologue]);

  const canGenerate =
    voice.source === "record" ? !!voice.recording : voice.script.trim().length > 0;

  return (
    <div className="glass-card p-6 rounded-3xl space-y-5">
      <h3 className="text-lg font-black text-white flex items-center gap-2">
        <Mic className="h-5 w-5 text-amber-500" />
        The voice
      </h3>

      {/* Source */}
      <div className="grid grid-cols-3 gap-2">
        {SOURCES.map((s) => {
          const active = voice.source === s.id;
          return (
            <button
              key={s.id}
              onClick={() => set("source", s.id)}
              className={`p-3 rounded-xl border text-left transition-all ${
                active
                  ? "bg-gradient-to-br from-amber-500/10 to-rose-500/10 border-amber-500/50"
                  : "bg-gray-950/40 border-white/5 hover:border-gray-700"
              }`}
            >
              <span className={active ? "text-amber-500" : "text-gray-500"}>{s.icon}</span>
              <span className="block text-[11px] font-bold text-white mt-1.5">{s.label}</span>
              <span className="block text-[9px] text-gray-500 leading-tight mt-0.5">{s.desc}</span>
            </button>
          );
        })}
      </div>

      {voice.source === "record" ? (
        <Recorder voice={voice} onChange={onChange} />
      ) : (
        <>
          <div className="space-y-2">
            <div className="flex justify-between items-center">
              <label className="text-xs font-bold text-gray-400">
                {voice.source === "persona" ? "Monologue (editable)" : "Your script"}
              </label>
              <span
                className={`text-[10px] font-bold ${
                  voice.script.length > MAX_SCRIPT ? "text-rose-400" : "text-gray-500"
                }`}
              >
                {voice.script.length}/{MAX_SCRIPT}
              </span>
            </div>
            <textarea
              value={voice.script}
              onChange={(e) => set("script", e.target.value.slice(0, MAX_SCRIPT))}
              placeholder={
                voice.source === "persona"
                  ? "The model's monologue appears here once analysis finishes…"
                  : "What should your dog say?"
              }
              className="w-full h-32 rounded-2xl p-4 text-white placeholder-gray-600 glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-none leading-relaxed text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="text-xs font-bold text-gray-400 block">Voice persona</label>
            <div className="grid grid-cols-2 gap-2">
              {PERSONAS.map((p) => {
                const active = voice.persona === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => set("persona", p.id)}
                    className={`flex items-center gap-2.5 p-2.5 rounded-xl border text-left transition-all ${
                      active
                        ? "bg-gradient-to-r from-amber-500/10 to-rose-500/10 border-amber-500/50"
                        : "bg-gray-950/40 border-white/5 hover:border-gray-700"
                    }`}
                  >
                    <span className="text-2xl">{p.emoji}</span>
                    <div className="min-w-0">
                      <span className="block text-[11px] font-bold text-white truncate">{p.label}</span>
                      <span className="block text-[9px] text-gray-500">{p.desc}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}

      <div className="pt-4 border-t border-white/5 space-y-3">
        {!ready ? (
          <>
            <p className="text-xs text-rose-400 font-semibold">Add your API keys to continue.</p>
            <button onClick={onOpenSettings} className="gradient-btn w-full">
              Set API keys
            </button>
          </>
        ) : (
          <button
            onClick={onGenerate}
            disabled={busy || !canGenerate}
            className="gradient-btn w-full py-4 disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <span className="flex items-center justify-center gap-2">
              {busy ? (
                <>
                  <div className="h-5 w-5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  {busyLabel}
                </>
              ) : voice.source === "record" ? (
                "Use this recording"
              ) : (
                "Generate voiceover"
              )}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Recorder
 * ------------------------------------------------------------------ */

function Recorder({
  voice,
  onChange,
}: {
  voice: VoiceConfig;
  onChange: (v: VoiceConfig) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Releasing the mic matters: browsers keep the recording indicator lit and
  // hold the device until every track is explicitly stopped.
  const releaseMic = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => releaseMic, [releaseMic]);

  const start = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((m) => MediaRecorder.isTypeSupported(m));

      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      recorder.onstop = () => {
        const blob = new Blob(chunks, { type: mimeType ?? "audio/webm" });
        if (voice.recordingUrl) URL.revokeObjectURL(voice.recordingUrl);
        onChange({ ...voice, recording: blob, recordingUrl: URL.createObjectURL(blob) });
        releaseMic();
      };

      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
      setElapsed(0);
      timerRef.current = window.setInterval(() => setElapsed((e) => e + 0.1), 100);
    } catch {
      setError("Microphone access was denied. Check your browser permissions.");
      releaseMic();
    }
  }, [voice, onChange, releaseMic]);

  const stop = useCallback(() => {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setRecording(false);
  }, []);

  const clear = useCallback(() => {
    if (voice.recordingUrl) URL.revokeObjectURL(voice.recordingUrl);
    onChange({ ...voice, recording: null, recordingUrl: "" });
    setElapsed(0);
  }, [voice, onChange]);

  const handleUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (voice.recordingUrl) URL.revokeObjectURL(voice.recordingUrl);
    onChange({ ...voice, recording: file, recordingUrl: URL.createObjectURL(file) });
  };

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
      setPlaying(false);
    } else {
      void audio.play();
      setPlaying(true);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl p-3 bg-sky-500/5 border border-sky-500/20 text-[11px] text-gray-400 leading-relaxed">
        <Info className="h-4 w-4 text-sky-400 shrink-0 mt-0.5" />
        <span>
          Your recording is embedded directly — ElevenLabs isn't called at all. The mouth still
          animates from the audio's loudness, but subtitles need word timings that only TTS
          provides, so they're off for recordings.
        </span>
      </div>

      {!voice.recording ? (
        <div className="space-y-3">
          <button
            onClick={recording ? stop : start}
            className={`w-full py-5 rounded-2xl font-bold flex items-center justify-center gap-2.5 transition-all ${
              recording
                ? "bg-rose-500/15 border border-rose-500/50 text-rose-400"
                : "bg-gradient-to-r from-amber-500 to-rose-500 text-white shadow-lg shadow-orange-500/20 hover:scale-[1.01]"
            }`}
          >
            {recording ? (
              <>
                <Square className="h-4 w-4 fill-current" />
                Stop · {elapsed.toFixed(1)}s
                <span className="ml-1 h-2 w-2 rounded-full bg-rose-500 animate-pulse" />
              </>
            ) : (
              <>
                <Mic className="h-5 w-5" />
                Start recording
              </>
            )}
          </button>

          {!recording && (
            <label className="flex items-center justify-center gap-2 text-xs font-bold text-gray-500 hover:text-white transition-colors cursor-pointer">
              <Upload className="h-3.5 w-3.5" />
              or upload an audio file
              <input type="file" accept="audio/*" onChange={handleUpload} className="hidden" />
            </label>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-3 rounded-2xl p-3 bg-gray-950/50 border border-white/5">
          <button
            onClick={togglePlay}
            className="h-10 w-10 shrink-0 rounded-xl bg-gradient-to-br from-amber-500 to-rose-500 text-white flex items-center justify-center"
            aria-label={playing ? "Pause" : "Play"}
          >
            {playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4 ml-0.5" />}
          </button>

          <div className="min-w-0 flex-1">
            <p className="text-xs font-bold text-white">Recording ready</p>
            <p className="text-[10px] text-gray-500">
              {(voice.recording.size / 1024).toFixed(0)} kB
            </p>
          </div>

          <button
            onClick={clear}
            className="h-9 w-9 shrink-0 rounded-xl bg-gray-900/60 border border-white/5 text-gray-400 hover:text-rose-400 flex items-center justify-center transition-colors"
            aria-label="Discard"
          >
            <Trash2 className="h-4 w-4" />
          </button>

          <audio
            ref={audioRef}
            src={voice.recordingUrl}
            onEnded={() => setPlaying(false)}
            className="hidden"
          />
        </div>
      )}

      {error && <p className="text-[11px] text-rose-400">{error}</p>}
    </div>
  );
}
