import { Captions, Clapperboard, Image as ImageIcon, SlidersHorizontal, FileVideo } from "lucide-react";
import type {
  BackgroundConfig,
  BackgroundId,
  CaptionConfig,
  CaptionStyle,
  ExportConfig,
  ExportFormat,
  PresetId,
  RigConfig,
} from "../types";
import { PRESETS } from "../render/rig";

interface StudioControlsProps {
  rigConfig: RigConfig;
  onRigChange: (config: RigConfig) => void;
  captions: CaptionConfig;
  onCaptionsChange: (config: CaptionConfig) => void;
  /** False when the audio has no word timings (a user recording). */
  captionsAvailable: boolean;
  background: BackgroundConfig;
  onBackgroundChange: (config: BackgroundConfig) => void;
  exportConfig: ExportConfig;
  onExportChange: (config: ExportConfig) => void;
}

/**
 * Ordered least to most motion. `still` leads because it is the most
 * convincing for a portrait — the frame holds and only the face moves.
 */
const PRESET_META: { id: PresetId; label: string; emoji: string; desc: string }[] = [
  { id: "still", label: "Locked Off", emoji: "🗿", desc: "Only face moves" },
  { id: "subtle", label: "Barely There", emoji: "🍃", desc: "Whisper of drift" },
  { id: "idle", label: "Portrait", emoji: "🎙️", desc: "Gentle sway" },
  { id: "roll", label: "Belly Roll", emoji: "🙃", desc: "Lazy sideways flop" },
  { id: "bounce", label: "Bouncy", emoji: "🏀", desc: "Springy on the beat" },
  { id: "zoomies", label: "Zoomies", emoji: "💨", desc: "Maximum chaos" },
];

const BACKGROUNDS: { id: BackgroundId; label: string; swatch: string }[] = [
  { id: "blur", label: "Blurred", swatch: "from-gray-600 to-gray-800" },
  { id: "original", label: "Original", swatch: "from-gray-500 to-gray-700" },
  { id: "sunset", label: "Sunset", swatch: "from-orange-400 via-amber-300 to-purple-800" },
  { id: "studio", label: "Studio", swatch: "from-amber-400 to-amber-900" },
  { id: "park", label: "Park", swatch: "from-sky-300 to-green-700" },
  { id: "neon", label: "Neon", swatch: "from-pink-500 to-blue-500" },
  { id: "solid", label: "Solid", swatch: "from-amber-500 to-amber-500" },
];

const CAPTION_STYLES: { id: CaptionStyle; label: string; desc: string }[] = [
  { id: "karaoke", label: "Karaoke", desc: "Rolling window, word highlight" },
  { id: "popup", label: "Pop-up", desc: "Two words, hard cuts" },
  { id: "minimal", label: "Minimal", desc: "Full sentence, subtle" },
];

const RESOLUTIONS = [
  { label: "1080 × 1920", width: 1080, height: 1920, note: "Reels / Shorts / TikTok" },
  { label: "720 × 1280", width: 720, height: 1280, note: "Faster export" },
  { label: "1080 × 1080", width: 1080, height: 1080, note: "Square feed post" },
];

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="glass-card p-5 rounded-3xl space-y-4">
      <h3 className="text-sm font-black text-white flex items-center gap-2 uppercase tracking-wide">
        {icon}
        {title}
      </h3>
      {children}
    </div>
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (v: number) => string;
  onChange: (v: number) => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex justify-between items-center">
        <label className="text-[11px] font-bold text-gray-400">{label}</label>
        <span className="text-[11px] font-bold text-amber-500 tabular-nums">
          {format ? format(value) : value.toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-amber-500 cursor-pointer"
      />
    </div>
  );
}

export function StudioControls({
  rigConfig,
  onRigChange,
  captions,
  onCaptionsChange,
  captionsAvailable,
  background,
  onBackgroundChange,
  exportConfig,
  onExportChange,
}: StudioControlsProps) {
  /**
   * Switching preset resets every rig coefficient to that preset's defaults.
   * Preserving manual tweaks across a preset change sounds friendlier but
   * produces incoherent hybrids - half Zoomies, half Portrait - and users end
   * up unable to get back to a clean look without reloading.
   */
  const selectPreset = (id: PresetId) => onRigChange({ ...PRESETS[id] });

  return (
    <div className="space-y-5">
      <Section
        icon={<Clapperboard className="h-4 w-4 text-amber-500" />}
        title="Animation style"
      >
        <div className="grid grid-cols-2 gap-2.5">
          {PRESET_META.map((preset) => {
            const active = rigConfig.preset === preset.id;
            return (
              <button
                key={preset.id}
                onClick={() => selectPreset(preset.id)}
                className={`flex items-center gap-2.5 p-3 rounded-xl border text-left transition-all duration-300 ${
                  active
                    ? "bg-gradient-to-r from-amber-500/10 to-rose-500/10 border-amber-500/50 shadow-lg shadow-amber-500/5"
                    : "bg-gray-950/40 border-white/5 hover:border-gray-700"
                }`}
              >
                <span className="text-2xl">{preset.emoji}</span>
                <div className="min-w-0">
                  <span className="block text-xs font-bold text-white">{preset.label}</span>
                  <span className="block text-[10px] text-gray-500 truncate">{preset.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </Section>

      <Section
        icon={<SlidersHorizontal className="h-4 w-4 text-amber-500" />}
        title="Fine tuning"
      >
        <Slider
          label="Mouth movement"
          value={rigConfig.jawMax}
          min={0}
          max={0.9}
          step={0.01}
          onChange={(v) => onRigChange({ ...rigConfig, jawMax: v })}
        />
        <Slider
          label="Head motion"
          value={rigConfig.swayAmp}
          min={0}
          max={0.08}
          step={0.002}
          onChange={(v) => onRigChange({ ...rigConfig, swayAmp: v })}
        />
        <Slider
          label="Emphasis nods"
          value={rigConfig.nodGain}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => onRigChange({ ...rigConfig, nodGain: v })}
        />
        <Slider
          label="Camera push-in"
          value={rigConfig.zoomEnd}
          min={1}
          max={1.4}
          step={0.01}
          format={(v) => `${Math.round((v - 1) * 100)}%`}
          onChange={(v) => onRigChange({ ...rigConfig, zoomEnd: v })}
        />
        <Slider
          label="Handheld shake"
          value={rigConfig.shakeAmp}
          min={0}
          max={0.02}
          step={0.0005}
          onChange={(v) => onRigChange({ ...rigConfig, shakeAmp: v })}
        />
        <Slider
          label="Background parallax"
          value={rigConfig.parallax}
          min={0}
          max={1}
          step={0.05}
          onChange={(v) => onRigChange({ ...rigConfig, parallax: v })}
        />
        <Slider
          label="Blink rate"
          value={rigConfig.blinkIntervalSec}
          min={1}
          max={10}
          step={0.25}
          format={(v) => `every ${v.toFixed(1)}s`}
          onChange={(v) => onRigChange({ ...rigConfig, blinkIntervalSec: v })}
        />
        <Slider
          label="Ear twitch"
          value={rigConfig.earTwitchAmp}
          min={0}
          max={0.5}
          step={0.01}
          onChange={(v) => onRigChange({ ...rigConfig, earTwitchAmp: v })}
        />
      </Section>

      <Section
        icon={<ImageIcon className="h-4 w-4 text-amber-500" />}
        title="Background"
      >
        <div className="grid grid-cols-4 gap-2">
          {BACKGROUNDS.map((bg) => {
            const active = background.id === bg.id;
            return (
              <button
                key={bg.id}
                onClick={() => onBackgroundChange({ ...background, id: bg.id })}
                className={`space-y-1.5 p-1.5 rounded-xl border transition-all ${
                  active ? "border-amber-500/60 bg-amber-500/5" : "border-white/5 hover:border-gray-700"
                }`}
              >
                <div className={`h-10 w-full rounded-lg bg-gradient-to-br ${bg.swatch}`} />
                <span className="block text-[9px] font-bold text-gray-400 truncate">{bg.label}</span>
              </button>
            );
          })}
        </div>

        {background.id === "blur" && (
          <Slider
            label="Blur strength"
            value={background.blurPx}
            min={4}
            max={80}
            step={2}
            format={(v) => `${v}px`}
            onChange={(v) => onBackgroundChange({ ...background, blurPx: v })}
          />
        )}

        {(background.id === "solid" || background.id === "studio") && (
          <div className="flex items-center justify-between">
            <label className="text-[11px] font-bold text-gray-400">Colour</label>
            <input
              type="color"
              value={background.color}
              onChange={(e) => onBackgroundChange({ ...background, color: e.target.value })}
              className="h-8 w-16 rounded-lg bg-transparent cursor-pointer border border-white/10"
            />
          </div>
        )}

        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-[11px] font-bold text-gray-400">Pulse with the voice</span>
          <input
            type="checkbox"
            checked={background.reactive}
            onChange={(e) => onBackgroundChange({ ...background, reactive: e.target.checked })}
            className="h-4 w-4 accent-amber-500 cursor-pointer"
          />
        </label>
      </Section>

      <Section
        icon={<Captions className="h-4 w-4 text-amber-500" />}
        title="Subtitles"
      >
        {!captionsAvailable ? (
          // Explain rather than silently disable: an unexplained dead toggle
          // reads as a bug, and this one has a real reason behind it.
          <p className="text-[11px] text-gray-500 leading-relaxed">
            Subtitles need per-word timings, which come from text-to-speech. Your own
            recording doesn't carry them, so subtitles are unavailable for this clip.
            Choose <strong className="text-gray-400">AI writes it</strong> or{" "}
            <strong className="text-gray-400">I'll write it</strong> to get them back.
          </p>
        ) : (
          <label className="flex items-center justify-between cursor-pointer">
            <span className="text-xs font-bold text-gray-300">Burn in subtitles</span>
            <input
              type="checkbox"
              checked={captions.enabled}
              onChange={(e) => onCaptionsChange({ ...captions, enabled: e.target.checked })}
              className="h-4 w-4 accent-amber-500 cursor-pointer"
            />
          </label>
        )}

        {captionsAvailable && captions.enabled && (
          <>
            <div className="grid grid-cols-3 gap-2">
              {CAPTION_STYLES.map((style) => {
                const active = captions.style === style.id;
                return (
                  <button
                    key={style.id}
                    onClick={() => onCaptionsChange({ ...captions, style: style.id })}
                    title={style.desc}
                    className={`p-2.5 rounded-xl border text-center transition-all ${
                      active
                        ? "bg-amber-500/10 border-amber-500/50 text-white"
                        : "bg-gray-950/40 border-white/5 text-gray-400 hover:border-gray-700"
                    }`}
                  >
                    <span className="block text-[11px] font-bold">{style.label}</span>
                  </button>
                );
              })}
            </div>

            <Slider
              label="Text size"
              value={captions.sizeRatio}
              min={0.03}
              max={0.09}
              step={0.002}
              format={(v) => `${Math.round(v * 1000)}`}
              onChange={(v) => onCaptionsChange({ ...captions, sizeRatio: v })}
            />
            <Slider
              label="Vertical position"
              value={captions.positionY}
              min={0.15}
              max={0.9}
              step={0.01}
              format={(v) => `${Math.round(v * 100)}%`}
              onChange={(v) => onCaptionsChange({ ...captions, positionY: v })}
            />

            <div className="flex items-center gap-4">
              <div className="flex-1 flex items-center justify-between">
                <label className="text-[11px] font-bold text-gray-400">Highlight</label>
                <input
                  type="color"
                  value={captions.highlightColor}
                  onChange={(e) => onCaptionsChange({ ...captions, highlightColor: e.target.value })}
                  className="h-8 w-14 rounded-lg bg-transparent cursor-pointer border border-white/10"
                />
              </div>
              <div className="flex-1 flex items-center justify-between">
                <label className="text-[11px] font-bold text-gray-400">Text</label>
                <input
                  type="color"
                  value={captions.textColor}
                  onChange={(e) => onCaptionsChange({ ...captions, textColor: e.target.value })}
                  className="h-8 w-14 rounded-lg bg-transparent cursor-pointer border border-white/10"
                />
              </div>
            </div>

            <label className="flex items-center justify-between cursor-pointer">
              <span className="text-[11px] font-bold text-gray-400">UPPERCASE</span>
              <input
                type="checkbox"
                checked={captions.uppercase}
                onChange={(e) => onCaptionsChange({ ...captions, uppercase: e.target.checked })}
                className="h-4 w-4 accent-amber-500 cursor-pointer"
              />
            </label>
          </>
        )}
      </Section>

      <Section
        icon={<FileVideo className="h-4 w-4 text-amber-500" />}
        title="Export"
      >
        <div className="grid grid-cols-2 gap-2">
          {(["mp4", "webm"] as ExportFormat[]).map((format) => {
            const active = exportConfig.format === format;
            return (
              <button
                key={format}
                onClick={() => onExportChange({ ...exportConfig, format })}
                className={`p-3 rounded-xl border text-center transition-all ${
                  active
                    ? "bg-amber-500/10 border-amber-500/50 text-white"
                    : "bg-gray-950/40 border-white/5 text-gray-400 hover:border-gray-700"
                }`}
              >
                <span className="block text-xs font-black uppercase">{format}</span>
                <span className="block text-[9px] text-gray-500 mt-0.5">
                  {format === "mp4" ? "H.264 · universal" : "VP9 · smaller"}
                </span>
              </button>
            );
          })}
        </div>

        <div className="space-y-2">
          {RESOLUTIONS.map((res) => {
            const active = exportConfig.width === res.width && exportConfig.height === res.height;
            return (
              <button
                key={res.label}
                onClick={() => onExportChange({ ...exportConfig, width: res.width, height: res.height })}
                className={`w-full flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                  active ? "bg-amber-500/10 border-amber-500/50" : "bg-gray-950/40 border-white/5 hover:border-gray-700"
                }`}
              >
                <span className="text-[11px] font-bold text-white">{res.label}</span>
                <span className="text-[10px] text-gray-500">{res.note}</span>
              </button>
            );
          })}
        </div>

        <Slider
          label="Frame rate"
          value={exportConfig.fps}
          min={24}
          max={60}
          step={6}
          format={(v) => `${v} fps`}
          onChange={(v) => onExportChange({ ...exportConfig, fps: v })}
        />
      </Section>
    </div>
  );
}
