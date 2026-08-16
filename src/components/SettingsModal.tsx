import { useCallback, useEffect, useState } from "react";
import { X, Key, Cloud, HardDrive, ExternalLink, ShieldCheck, RefreshCw, Eye, AlertTriangle } from "lucide-react";
import type { AiProvider, ApiKeys } from "../types";
import { isLocalOllama, listOllamaModels, partitionVisionModels } from "../services/vision";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  apiKeys: ApiKeys;
  onSave: (keys: ApiKeys) => void;
}

const GEMINI_MODELS = [
  { id: "gemini-flash-latest", label: "Flash (latest)", note: "Tracks the current Flash release" },
  { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", note: "Pinned, 1M context" },
  { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", note: "Older, widely available" },
];

export function SettingsModal({ isOpen, onClose, apiKeys, onSave }: SettingsModalProps) {
  const [draft, setDraft] = useState<ApiKeys>(apiKeys);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);

  // Re-sync when reopened, so cancelling out doesn't leave a stale draft.
  useEffect(() => {
    if (isOpen) setDraft(apiKeys);
  }, [isOpen, apiKeys]);

  const refreshModels = useCallback(async () => {
    setModelsLoading(true);
    setModelsError(null);
    try {
      setModels(await listOllamaModels(draft.ollamaUrl ?? "", draft.ollamaKey ?? ""));
    } catch (err) {
      setModels([]);
      setModelsError(err instanceof Error ? err.message : "Could not reach the server.");
    } finally {
      setModelsLoading(false);
    }
  }, [draft.ollamaUrl, draft.ollamaKey]);

  /**
   * Refetch whenever the endpoint changes, debounced - the URL field fires on
   * every keystroke and "http://localhost:1" is not worth a request.
   */
  useEffect(() => {
    if (!isOpen || draft.aiProvider !== "ollama") return;
    const timer = setTimeout(refreshModels, 500);
    return () => clearTimeout(timer);
  }, [isOpen, draft.aiProvider, refreshModels]);

  if (!isOpen) return null;

  const provider: AiProvider = draft.aiProvider ?? "gemini";
  const usingLocalOllama = isLocalOllama(draft.ollamaUrl ?? "");

  const set = <K extends keyof ApiKeys>(key: K, value: ApiKeys[K]) => setDraft((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    onSave(draft);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/70 backdrop-blur-sm"
        onClick={onClose}
      />

      <div className="relative w-full max-w-lg max-h-[88vh] overflow-y-auto glass-card rounded-3xl p-6 space-y-6 border border-white/10 shadow-2xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-xl font-black text-white flex items-center gap-2">
              <Key className="h-5 w-5 text-amber-500" />
              API keys
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Stored in your browser's local storage. Nothing is sent to any server of ours - there isn't one.
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-gray-500 hover:text-white transition-colors p-1"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ElevenLabs */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-sm font-bold text-gray-300">ElevenLabs API key</label>
            <a
              href="https://elevenlabs.io/docs/eleven-api/quickstart"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-amber-500 hover:text-amber-400 flex items-center gap-1"
            >
              Get one <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <input
            type="password"
            value={draft.elevenLabsKey}
            onChange={(e) => set("elevenLabsKey", e.target.value)}
            placeholder="sk_…"
            className="w-full rounded-xl p-3 text-sm text-white glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50"
          />
          <p className="text-[11px] text-gray-600">
            Used for the voiceover and its word-level timestamps, which drive both the subtitles and the mouth
            animation.
          </p>
        </div>

        <div className="border-t border-white/5 pt-5 space-y-4">
          <label className="text-sm font-bold text-gray-300 block">Vision model</label>

          <div className="grid grid-cols-2 gap-2">
            {(["gemini", "ollama"] as AiProvider[]).map((id) => {
              const active = provider === id;
              return (
                <button
                  key={id}
                  onClick={() => set("aiProvider", id)}
                  className={`p-3 rounded-xl border text-left transition-all ${
                    active
                      ? "bg-amber-500/10 border-amber-500/50"
                      : "bg-gray-950/40 border-white/5 hover:border-gray-700"
                  }`}
                >
                  <span className="block text-xs font-bold text-white">
                    {id === "gemini" ? "Google Gemini" : "Ollama"}
                  </span>
                  <span className="block text-[10px] text-gray-500 mt-0.5">
                    {id === "gemini" ? "Cloud, no setup" : "Cloud or your own machine"}
                  </span>
                </button>
              );
            })}
          </div>

          {provider === "gemini" ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-gray-400">Gemini API key</label>
                <a
                  href="https://aistudio.google.com/apikey"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[11px] text-amber-500 hover:text-amber-400 flex items-center gap-1"
                >
                  Get one <ExternalLink className="h-3 w-3" />
                </a>
              </div>
              <input
                type="password"
                value={draft.geminiKey}
                onChange={(e) => set("geminiKey", e.target.value)}
                placeholder="AIza…"
                className="w-full rounded-xl p-3 text-sm text-white glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50"
              />

              <label className="text-xs font-bold text-gray-400 block">Model</label>
              <div className="space-y-1.5">
                {GEMINI_MODELS.map((model) => {
                  const active = draft.geminiModel === model.id;
                  return (
                    <button
                      key={model.id}
                      onClick={() => set("geminiModel", model.id)}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl border transition-all ${
                        active
                          ? "bg-amber-500/10 border-amber-500/50"
                          : "bg-gray-950/40 border-white/5 hover:border-gray-700"
                      }`}
                    >
                      <span className="text-[11px] font-bold text-white">{model.label}</span>
                      <span className="text-[10px] text-gray-500">{model.note}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <label className="text-xs font-bold text-gray-400 block">Server URL</label>
              <input
                type="text"
                value={draft.ollamaUrl}
                onChange={(e) => set("ollamaUrl", e.target.value)}
                placeholder="Leave blank for Ollama Cloud, or http://localhost:11434"
                className="w-full rounded-xl p-3 text-sm text-white glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50"
              />

              <div className="flex items-start gap-2 text-[11px] leading-relaxed rounded-xl p-3 bg-gray-950/60 border border-white/5">
                {usingLocalOllama ? (
                  <>
                    <HardDrive className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
                    <span className="text-gray-400">
                      Local instance - nothing leaves your machine. Start Ollama with{" "}
                      <code className="text-amber-500">OLLAMA_ORIGINS="*"</code> so the browser is allowed to call it.
                    </span>
                  </>
                ) : (
                  <>
                    <Cloud className="h-4 w-4 text-sky-500 shrink-0 mt-0.5" />
                    <span className="text-gray-400">
                      Ollama Cloud. Requests go through a same-origin{" "}
                      <code className="text-amber-500">/ollama-api</code> rewrite, because Ollama Cloud sends no CORS
                      headers and the browser would otherwise refuse the call.
                    </span>
                  </>
                )}
              </div>

              {!usingLocalOllama && (
                <>
                  <label className="text-xs font-bold text-gray-400 block">Ollama API key</label>
                  <input
                    type="password"
                    value={draft.ollamaKey}
                    onChange={(e) => set("ollamaKey", e.target.value)}
                    placeholder="Required for Ollama Cloud"
                    className="w-full rounded-xl p-3 text-sm text-white glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50"
                  />
                </>
              )}

              <div className="flex items-center justify-between">
                <label className="text-xs font-bold text-gray-400">Vision model</label>
                <button
                  onClick={refreshModels}
                  disabled={modelsLoading}
                  className="text-[11px] text-amber-500 hover:text-amber-400 flex items-center gap-1 disabled:opacity-50"
                >
                  <RefreshCw className={`h-3 w-3 ${modelsLoading ? "animate-spin" : ""}`} />
                  {modelsLoading ? "Checking…" : "Refresh"}
                </button>
              </div>

              <ModelPicker
                models={models}
                loading={modelsLoading}
                error={modelsError}
                value={draft.ollamaModel}
                isLocal={usingLocalOllama}
                onChange={(m) => set("ollamaModel", m)}
              />
            </div>
          )}
        </div>

        <div className="flex items-start gap-2 text-[11px] text-gray-500 leading-relaxed border-t border-white/5 pt-4">
          <ShieldCheck className="h-4 w-4 text-emerald-500 shrink-0 mt-0.5" />
          <span>
            Keys live in local storage and are sent only to the provider you picked. Anyone with access to this browser
            profile can read them, so use a restricted key rather than your main one.
          </span>
        </div>

        <button
          onClick={handleSave}
          className="w-full rounded-2xl bg-gradient-to-r from-amber-500 via-orange-500 to-rose-500 px-6 py-3.5 text-white font-bold hover:scale-[1.01] active:scale-[0.99] transition-all shadow-xl shadow-orange-500/20"
        >
          Save keys
        </button>
      </div>
    </div>
  );
}

/**
 * Lists what the server actually reports, with likely-vision models surfaced
 * first. Models without vision are still shown but marked, because the
 * capability check is a name heuristic and shouldn't hard-block a model the
 * user knows works.
 */
function ModelPicker({
  models,
  loading,
  error,
  value,
  isLocal,
  onChange,
}: {
  models: string[];
  loading: boolean;
  error: string | null;
  value: string;
  isLocal: boolean;
  onChange: (model: string) => void;
}) {
  // Text-only models are filtered out entirely rather than shown greyed: the
  // list is long, and a model that cannot see the photo is never a valid
  // choice here, so listing it is pure noise.
  const { vision } = partitionVisionModels(models);

  if (loading && models.length === 0) {
    return (
      <div className="rounded-xl p-3 bg-gray-950/60 border border-white/5 text-[11px] text-gray-500">
        Asking the server what it has…
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        <div className="flex items-start gap-2 rounded-xl p-3 bg-rose-500/5 border border-rose-500/20 text-[11px] text-rose-400 leading-relaxed">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            {error}
            {isLocal && ' Is Ollama running, and started with OLLAMA_ORIGINS="*"?'}
          </span>
        </div>
        {/* Still allow a manual name - discovery failing shouldn't lock them out. */}
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Type a model name"
          className="w-full rounded-xl p-3 text-sm text-white glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50"
        />
      </div>
    );
  }

  if (vision.length === 0) {
    return (
      <div className="rounded-xl p-3 bg-gray-950/60 border border-white/5 text-[11px] text-gray-500">
        {isLocal
          ? "No vision models pulled yet. Try: ollama pull gemma4:12b"
          : "This server reports no vision-capable models."}
      </div>
    );
  }

  const row = (name: string) => {
    const active = value === name;
    return (
      <button
        key={name}
        onClick={() => onChange(name)}
        className={`w-full flex items-center justify-between gap-2 p-2.5 rounded-xl border transition-all text-left ${
          active ? "bg-amber-500/10 border-amber-500/50" : "bg-gray-950/40 border-white/5 hover:border-gray-700"
        }`}
      >
        <span className="text-[11px] font-bold text-white truncate">{name}</span>
        <span className="flex items-center gap-1 text-[9px] font-bold text-emerald-500 shrink-0">
          <Eye className="h-3 w-3" />
          VISION
        </span>
      </button>
    );
  };

  // A stored model that the server doesn't offer selects nothing, which just
  // looks like a rendering bug. Say what's wrong instead.
  const missing = value && !vision.includes(value);

  return (
    <div className="space-y-1.5">
      {missing && (
        <div className="flex items-start gap-2 rounded-xl p-3 bg-amber-500/5 border border-amber-500/20 text-[11px] text-amber-400 leading-relaxed">
          <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" />
          <span>
            <strong>{value}</strong> isn't available here
            {isLocal ? " - pull it, or pick one below." : " - pick one below."}
          </span>
        </div>
      )}

      <div className="space-y-1.5 max-h-56 overflow-y-auto pr-1">
        {vision.map((m) => row(m))}
      </div>
    </div>
  );
}
