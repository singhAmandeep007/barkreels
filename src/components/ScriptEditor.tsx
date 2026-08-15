import { RefreshCw, Sparkles, Hash, Volume2 } from 'lucide-react';
import type { DogAnalysis } from '../types';

interface ScriptEditorProps {
  analysis: DogAnalysis;
  onUpdate: (analysis: DogAnalysis) => void;
  onRegenerate: () => void;
  isLoading: boolean;
}

const VOICE_OPTIONS = [
  { id: 'deep' as const, label: 'Deep & Wise', emoji: '🧙‍♂️', desc: 'Gravitas & wisdom' },
  { id: 'playful' as const, label: 'Playful Puppy', emoji: '🎾', desc: 'Energetic & high' },
  { id: 'dramatic' as const, label: 'Dramatic Actor', emoji: '🎭', desc: 'Over-the-top emotion' },
  { id: 'sassy' as const, label: 'Sassy Diva', emoji: '💅', desc: 'Posh & confident' },
];

export function ScriptEditor({ analysis, onUpdate, onRegenerate, isLoading }: ScriptEditorProps) {
  return (
    <div className="w-full max-w-2xl mx-auto space-y-6 animate-slide-up">
      {/* AI Analysis Summary */}
      <div className="glass-card p-6 rounded-3xl relative overflow-hidden">
        <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl pointer-events-none" />
        
        <div className="flex justify-between items-center mb-5">
          <h3 className="text-lg font-bold text-white flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-amber-500" />
            Dog Portrait Insights
          </h3>
          <button
            onClick={onRegenerate}
            disabled={isLoading}
            className="flex items-center gap-2 text-xs font-semibold bg-gray-800/40 hover:bg-gray-800/80 border border-gray-700/50 px-3 py-1.5 rounded-full text-gray-300 hover:text-white transition-all duration-300 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w.5 ${isLoading ? 'animate-spin' : ''}`} />
            Re-Analyze
          </button>
        </div>
        
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div className="bg-gray-950/40 border border-white/5 p-3 rounded-xl">
            <span className="block text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Breed Guess</span>
            <span className="text-sm font-semibold text-white">{analysis.breed}</span>
          </div>
          <div className="bg-gray-950/40 border border-white/5 p-3 rounded-xl">
            <span className="block text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Detected Mood</span>
            <span className="text-sm font-semibold text-white">{analysis.mood}</span>
          </div>
          <div className="bg-gray-950/40 border border-white/5 p-3 rounded-xl">
            <span className="block text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">Personality</span>
            <span className="text-sm font-semibold text-white">{analysis.personality}</span>
          </div>
        </div>
      </div>

      {/* Script Editor */}
      <div className="glass-card p-6 rounded-3xl space-y-6">
        <div>
          <div className="flex justify-between items-center mb-3">
            <label className="text-sm font-semibold text-gray-300">
              Inner Monologue Script
            </label>
            <span className="text-[10px] font-bold text-gray-500 uppercase">
              {analysis.monologue.length} chars
            </span>
          </div>
          <textarea
            value={analysis.monologue}
            onChange={(e) => onUpdate({ ...analysis, monologue: e.target.value })}
            className="w-full h-36 rounded-2xl p-4 text-white placeholder-gray-500 glass-input focus:outline-none focus:ring-1 focus:ring-amber-500/50 resize-none leading-relaxed text-sm"
            placeholder="What is your dog thinking?..."
          />
        </div>

        {/* Voice Selection */}
        <div>
          <label className="block text-sm font-semibold text-gray-300 mb-3 flex items-center gap-2">
            <Volume2 className="h-4 w-4 text-amber-500" />
            Choose Voice Persona
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {VOICE_OPTIONS.map((voice) => {
              const isSelected = analysis.suggestedVoice === voice.id;
              return (
                <button
                  key={voice.id}
                  onClick={() => onUpdate({ ...analysis, suggestedVoice: voice.id })}
                  className={`flex items-center gap-3 p-3.5 rounded-xl border text-left transition-all duration-300 ${
                    isSelected
                      ? 'bg-gradient-to-r from-amber-500/10 to-rose-500/10 border-amber-500/50 text-white shadow-lg shadow-amber-500/5'
                      : 'bg-gray-950/40 border-white/5 text-gray-400 hover:border-gray-800 hover:text-gray-200'
                  }`}
                >
                  <span className="text-3xl filter drop-shadow">{voice.emoji}</span>
                  <div>
                    <span className="block text-xs font-bold text-white">{voice.label}</span>
                    <span className="block text-[10px] text-gray-500 mt-0.5">{voice.desc}</span>
                  </div>
                  {isSelected && (
                    <div className="ml-auto w-2 h-2 rounded-full bg-amber-500 animate-pulse-glow" />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* Hashtags */}
        {analysis.hashtags && analysis.hashtags.length > 0 && (
          <div className="pt-4 border-t border-white/5">
            <label className="block text-sm font-semibold text-gray-400 mb-3">
              Suggested Tags
            </label>
            <div className="flex flex-wrap gap-2">
              {analysis.hashtags.map((tag) => (
                <span
                  key={tag}
                  className="flex items-center gap-1 text-[11px] font-bold text-amber-500 bg-amber-500/5 border border-amber-500/10 px-3 py-1.5 rounded-full"
                >
                  <Hash className="h-3 w-3 opacity-60" />
                  {tag.replace('#', '').toLowerCase()}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
