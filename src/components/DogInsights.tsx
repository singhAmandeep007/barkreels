import { Sparkles, Hash, Lock } from "lucide-react";
import type { DogAnalysis } from "../types";

interface DogInsightsProps {
  analysis: DogAnalysis;
  /**
   * Once the voiceover exists, the analysis is baked into it — the timestamps,
   * the envelope and the caption timings all derive from that exact audio.
   * Showing an editable panel at that point invites changes that silently do
   * nothing, so we mark it locked instead.
   */
  locked: boolean;
}

export function DogInsights({ analysis, locked }: DogInsightsProps) {
  const facts = [
    { label: "Breed guess", value: analysis.breed },
    { label: "Mood", value: analysis.mood },
    { label: "Personality", value: analysis.personality },
  ];

  return (
    <div className="glass-card p-6 rounded-3xl relative overflow-hidden space-y-5">
      <div className="absolute top-0 right-0 w-32 h-32 bg-amber-500/5 rounded-full blur-2xl pointer-events-none" />

      <div className="flex justify-between items-center">
        <h3 className="text-lg font-bold text-white flex items-center gap-2">
          <Sparkles className="h-5 w-5 text-amber-500" />
          Portrait insights
        </h3>
        {locked && (
          <span className="flex items-center gap-1.5 text-[10px] font-bold text-gray-500 uppercase tracking-wide">
            <Lock className="h-3 w-3" />
            Locked
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {facts.map((fact) => (
          <div key={fact.label} className="bg-gray-950/40 border border-white/5 p-3 rounded-xl">
            <span className="block text-[10px] uppercase tracking-wider text-gray-500 font-bold mb-1">
              {fact.label}
            </span>
            <span className="text-sm font-semibold text-white">{fact.value}</span>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-3">
        <span className="text-[10px] uppercase tracking-wider text-gray-500 font-bold shrink-0">
          Energy
        </span>
        <div className="h-1.5 flex-1 bg-gray-900 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-sky-500 via-amber-500 to-rose-500"
            style={{ width: `${analysis.energy * 100}%` }}
          />
        </div>
        <span className="text-[10px] font-bold text-amber-500 tabular-nums shrink-0">
          {Math.round(analysis.energy * 100)}%
        </span>
      </div>

      {analysis.hashtags.length > 0 && (
        <div className="pt-4 border-t border-white/5">
          <label className="block text-xs font-semibold text-gray-500 mb-2.5">
            Suggested tags
          </label>
          <div className="flex flex-wrap gap-2">
            {analysis.hashtags.map((tag) => (
              <span
                key={tag}
                className="flex items-center gap-1 text-[11px] font-bold text-amber-500 bg-amber-500/5 border border-amber-500/10 px-3 py-1.5 rounded-full"
              >
                <Hash className="h-3 w-3 opacity-60" />
                {tag.replace("#", "").toLowerCase()}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
