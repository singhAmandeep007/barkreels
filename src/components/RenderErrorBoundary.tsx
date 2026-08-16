import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";

/**
 * Catches render-path failures so they don't take the page with them.
 *
 * The renderer touches a lot of browser surface that throws rather than
 * returning errors — canvas `drawImage`, WebGL context creation, WebCodecs.
 * React's default for an uncaught error in a subtree is to unmount the entire
 * root, so a single bad texture turned the whole app into a blank page and
 * took the user's uploaded photo, analysis and generated audio with it.
 *
 * Scoped deliberately tight: it wraps only the preview, so a failure there
 * leaves the controls and the project intact and the user can change a setting
 * and retry instead of starting over.
 */
interface Props {
  children: ReactNode;
  /** Changing this resets the boundary — e.g. when the user picks a new photo. */
  resetKey?: string;
}

interface State {
  error: Error | null;
}

export class RenderErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidUpdate(prev: Props) {
    // A new source is a new chance; clear the error rather than making the
    // user find the reset button.
    if (prev.resetKey !== this.props.resetKey && this.state.error) {
      this.setState({ error: null });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Render failed:", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="w-full max-w-sm mx-auto glass-card p-6 rounded-3xl space-y-4">
        <h3 className="text-sm font-black text-white flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          The preview stopped
        </h3>
        <p className="text-[11px] text-gray-400 leading-relaxed">
          Something in the render path failed. Your photo, analysis and audio are
          all still here — changing a setting is usually enough to recover.
        </p>
        <p className="text-[10px] text-gray-600 font-mono break-words leading-relaxed">
          {this.state.error.message}
        </p>
        <button
          onClick={() => this.setState({ error: null })}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-xl bg-gray-900/60 border border-white/5 text-xs font-bold text-gray-300 hover:text-white transition-colors"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Try again
        </button>
      </div>
    );
  }
}
