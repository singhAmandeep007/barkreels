import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * `base` has to be set when deploying to GitHub Pages, because Pages serves a
 * project site from https://<user>.github.io/<repo>/ rather than from the
 * domain root. Without it every asset URL points one directory too high and
 * the page loads as a blank white screen with 404s in the console.
 *
 * The workflow passes the repo name in, so this stays correct if the repo is
 * ever renamed. Netlify, Vercel and `npm run dev` all serve from the root and
 * leave it unset.
 */
const base = process.env.VITE_BASE_PATH ?? "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      // Ollama Cloud sends no CORS headers, so it is reached through a
      // same-origin path. This proxy covers dev; production needs an
      // equivalent rewrite from the host (see public/_redirects, vercel.json).
      // GitHub Pages cannot rewrite at all, which is why builds for Pages set
      // VITE_OLLAMA_PROXY=false and the app hides the Ollama provider.
      "/ollama-api": {
        target: "https://ollama.com",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ollama-api/, ""),
      },
    },
  },
});
