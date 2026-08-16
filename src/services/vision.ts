/**
 * Vision analysis: breed, mood, monologue - and, critically, *where the mouth
 * is*, so the rig knows what to deform.
 *
 * Two providers behind one interface:
 *
 *   Gemini  Called directly from the browser. Google's generativelanguage
 *           endpoint sends permissive CORS headers, so no proxy is needed.
 *
 *   Ollama  Ollama Cloud only. It does *not* send CORS headers - its OPTIONS
 *           handler returns 405 - so every call is routed through a
 *           same-origin `/ollama-api` path that Vite rewrites in dev and the
 *           static host rewrites in production. Pure config, no server code;
 *           see vite.config.ts, public/_redirects and vercel.json.
 */

import type { AiProvider, ApiKeys, DogAnalysis, DogAnchors, NormBox } from "../types";

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function fileToBase64(file: File | Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function extractJSON(s: string): string {
  let out = s.trim();
  out = out
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/, "")
    .trim();
  const start = out.indexOf("{");
  const end = out.lastIndexOf("}");
  return start >= 0 && end > start ? out.slice(start, end + 1) : out;
}

/**
 * Gemini reports detections as [ymin, xmin, ymax, xmax] scaled to 0–1000.
 * That ordering is genuinely unusual - y first, and the corners rather than
 * origin+size - so converting it in exactly one place avoids a whole class of
 * transposed-coordinate bugs downstream.
 */
function boxFrom1000(arr: unknown): NormBox | null {
  if (!Array.isArray(arr) || arr.length !== 4) return null;
  const [ymin, xmin, ymax, xmax] = arr.map(Number);
  if ([ymin, xmin, ymax, xmax].some((n) => !Number.isFinite(n))) return null;

  const x = Math.min(xmin, xmax) / 1000;
  const y = Math.min(ymin, ymax) / 1000;
  const w = Math.abs(xmax - xmin) / 1000;
  const h = Math.abs(ymax - ymin) / 1000;

  if (w <= 0 || h <= 0) return null;
  return { x, y, w, h };
}

function parseAnchors(raw: Record<string, unknown> | undefined): DogAnchors | null {
  if (!raw) return null;

  const head = boxFrom1000(raw.head);
  const mouth = boxFrom1000(raw.mouth);
  if (!head || !mouth) return null;

  const chestRaw = raw.chest;
  const chest =
    Array.isArray(chestRaw) && chestRaw.length === 2
      ? { x: Number(chestRaw[1]) / 1000, y: Number(chestRaw[0]) / 1000 }
      : { x: head.x + head.w / 2, y: Math.min(1, head.y + head.h * 1.6) };

  return {
    head,
    mouth,
    nose: boxFrom1000(raw.nose),
    leftEye: boxFrom1000(raw.left_eye),
    rightEye: boxFrom1000(raw.right_eye),
    leftEar: boxFrom1000(raw.left_ear),
    rightEar: boxFrom1000(raw.right_ear),
    chest,
  };
}

const VOICES = ["deep", "playful", "dramatic", "sassy"] as const;

function coerceAnalysis(parsed: Record<string, unknown>): DogAnalysis {
  const voice = String(parsed.suggestedVoice ?? "").toLowerCase();

  return {
    breed: String(parsed.breed ?? "Very Good Dog"),
    mood: String(parsed.mood ?? "content"),
    personality: String(parsed.personality ?? "chaotic good"),
    monologue: String(parsed.monologue ?? ""),
    suggestedVoice: (VOICES as readonly string[]).includes(voice)
      ? (voice as DogAnalysis["suggestedVoice"])
      : "playful",
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.map((t) => String(t).replace(/^#/, ""))
      : ["dogsofdev", "goodboy"],
    anchors: parseAnchors(parsed.anchors as Record<string, unknown> | undefined),
    energy: Math.max(0, Math.min(1, Number(parsed.energy ?? 0.5) || 0.5)),
  };
}

/**
 * Build the prompt for the fields we actually need.
 *
 * `monologue` and `suggestedVoice` are only requested when the user has asked
 * the model to write for them. When they're supplying their own script or
 * recording, asking anyway wastes tokens and - worse - invites the model to
 * spend its attention on comedy instead of on the anchor coordinates, which
 * are the part the animation genuinely can't work without.
 */
export function buildPrompt(includeWriting: boolean): string {
  const writingJob = includeWriting
    ? `
JOB 1 - Character: invent a funny, relatable inner monologue (2-4 sentences, under 320 characters) that would go viral as a Reel. Make it specific to what you actually see in THIS photo, not generic dog humour.
`
    : "";

  const writingFields = includeWriting
    ? `
  "monologue": "the funny inner monologue",
  "suggestedVoice": "one of: deep, playful, dramatic, sassy",`
    : "";

  return `You are a precise dog-photo annotator${includeWriting ? " AND a hilarious dog whisperer" : ""}.
${writingJob}
${includeWriting ? "JOB 2 - " : ""}Annotation: locate the dog's features. Report every box as [ymin, xmin, ymax, xmax] normalised to 0-1000.

Be precise, because these coordinates drive the animation directly:
- "nose" is the NOSE LEATHER only: the dark wet pad at the very tip of the snout. Nothing else.
- "mouth" is the MOUTH LINE only: the seam where the upper and lower lips meet, and the chin below it. It sits BELOW the nose and must NOT overlap it. This is the single most common mistake - do not return the whole muzzle or snout here. If the lips are closed, box the visible lip seam and the chin under it.
- Sanity check before answering: the top of "mouth" must be greater than the bottom of "nose". If it isn't, you have boxed the muzzle; redo it.
- "left_ear" and "right_ear" cover each ear from its base on the skull to its tip. Left and right are from the VIEWER's perspective. If an ear is hidden or cropped out, use null.
- "chest" is a single [y, x] point at the centre of the dog's chest.
- If the photo is a profile view and a feature is not visible, use null rather than guessing.

Return ONLY this JSON, no markdown:
{
  "breed": "best guess",
  "mood": "two or three words",
  "personality": "two or three words",${writingFields}
  "hashtags": ["three to five tags without the # symbol"],
  "energy": 0.0 to 1.0 (0 = asleep, 1 = full zoomies),
  "anchors": {
    "head": [ymin, xmin, ymax, xmax],
    "nose": [ymin, xmin, ymax, xmax],
    "mouth": [ymin, xmin, ymax, xmax],
    "left_eye": [ymin, xmin, ymax, xmax] or null,
    "right_eye": [ymin, xmin, ymax, xmax] or null,
    "left_ear": [ymin, xmin, ymax, xmax] or null,
    "right_ear": [ymin, xmin, ymax, xmax] or null,
    "chest": [y, x]
  }
}`;
}

/* ------------------------------------------------------------------ *
 * Gemini
 * ------------------------------------------------------------------ */

/**
 * Tried in order. `gemini-flash-latest` is an alias that tracks whichever
 * Flash model is current, which is exactly what we want for a project that
 * will sit unmaintained after the challenge - the pinned IDs behind it are
 * insurance for the day the alias itself moves or a key lacks access.
 *
 * Note for future readers: the 1.5 and 2.0 families are retired (2.0 Flash was
 * shut down on 2026-06-01), so do not add them back as fallbacks.
 */
const GEMINI_FALLBACKS = ["gemini-flash-latest", "gemini-3.5-flash", "gemini-2.5-flash"];

async function analyzeWithGemini(
  file: File | Blob,
  apiKey: string,
  preferredModel: string,
  includeWriting: boolean
): Promise<DogAnalysis> {
  if (!apiKey) throw new Error("Gemini API key is required.");

  const base64 = await fileToBase64(file);
  const mimeType = file.type || "image/jpeg";

  const models = [preferredModel, ...GEMINI_FALLBACKS.filter((m) => m !== preferredModel)];

  let lastError: Error | null = null;

  for (const model of models) {
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Header auth rather than ?key= so the key never lands in a URL,
          // where it would leak into logs, history and Referer headers.
          "x-goog-api-key": apiKey,
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: buildPrompt(includeWriting) }, { inline_data: { mime_type: mimeType, data: base64 } }],
            },
          ],
          generationConfig: {
            temperature: 0.9,
            responseMimeType: "application/json",
          },
        }),
      });

      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        const message = (body as { error?: { message?: string } }).error?.message ?? `HTTP ${response.status}`;

        // Only a missing model justifies trying the next candidate; a bad key
        // or an exhausted quota will fail identically on every model, and
        // retrying just burns the user's time.
        if (response.status === 404 || /not found|not supported/i.test(message)) {
          lastError = new Error(`${model}: ${message}`);
          continue;
        }
        throw new Error(`Gemini error: ${message}`);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Gemini returned an empty response.");

      const parsed = JSON.parse(extractJSON(text));
      const analysis = coerceAnalysis(parsed);
      if (includeWriting && !analysis.monologue) {
        throw new Error("Gemini returned no monologue.");
      }
      return analysis;
    } catch (err) {
      if (err instanceof Error && /not found|not supported|404/i.test(err.message)) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }

  throw new Error(`No available Gemini model accepted the request. Last error: ${lastError?.message ?? "unknown"}`);
}

/* ------------------------------------------------------------------ *
 * Ollama
 * ------------------------------------------------------------------ */

/**
 * Ollama Cloud is reached through a same-origin path, never directly.
 *
 * ollama.com returns 405 on OPTIONS and sends no CORS headers, so the browser
 * refuses the preflight for any authenticated JSON POST. A host rewrite maps
 * this path onto ollama.com - Vite in dev, `_redirects` / `vercel.json` in
 * production. Pure config, no server code, so the app stays client-only.
 */
export const OLLAMA_ENDPOINT = "/ollama-api";

/**
 * Ask the server which models it actually has.
 *
 * Hardcoding model names is how you end up shipping a 404: Ollama Cloud hosts
 * a small catalogue of large models, and the popular local vision models
 * (`qwen3-vl`, `llama3.2-vision`) are simply not in it. The catalogue also
 * changes without notice, so we ask rather than guess.
 *
 * `/api/tags` needs no auth on Cloud, but we send the key when we have one.
 */
export async function listOllamaModels(apiKey: string): Promise<string[]> {
  const endpoint = OLLAMA_ENDPOINT;
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const response = await fetch(`${endpoint}/api/tags`, { headers });
  if (!response.ok) {
    throw new Error(`Could not list models (HTTP ${response.status}).`);
  }

  const data = await response.json();
  const models: string[] = Array.isArray(data?.models)
    ? data.models.map((m: { name?: string; model?: string }) => m.name ?? m.model ?? "")
    : [];

  return models.filter(Boolean).sort();
}

/**
 * Vision-capable families, checked as name prefixes.
 *
 * `/api/tags` reports no capability metadata, so this is the one piece we
 * can't discover and have to know. Kept as a family list rather than exact
 * tags so new sizes and point releases match without an edit.
 */
const VISION_FAMILIES = ["gemma4", "gemma3", "minimax-m3"];

export function isVisionModel(name: string): boolean {
  const lower = name.toLowerCase();
  return VISION_FAMILIES.some((family) => lower.startsWith(family));
}

/** Split a model list into likely-vision and the rest, preserving order. */
export function partitionVisionModels(models: string[]): {
  vision: string[];
  other: string[];
} {
  const vision: string[] = [];
  const other: string[] = [];
  for (const m of models) (isVisionModel(m) ? vision : other).push(m);
  return { vision, other };
}

async function analyzeWithOllama(
  file: File | Blob,
  model: string,
  apiKey: string,
  includeWriting: boolean
): Promise<DogAnalysis> {
  const base64 = await fileToBase64(file);
  const endpoint = OLLAMA_ENDPOINT;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  let response: Response;
  try {
    response = await fetch(`${endpoint}/api/chat`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildPrompt(includeWriting), images: [base64] }],
        stream: false,
        options: { temperature: 0.9 },
        // Ollama's structured-output mode: a JSON schema constrains decoding,
        // so we get parseable output instead of a model that felt chatty.
        format: {
          type: "object",
          properties: {
            breed: { type: "string" },
            mood: { type: "string" },
            personality: { type: "string" },
            ...(includeWriting
              ? {
                  monologue: { type: "string" },
                  suggestedVoice: { type: "string", enum: [...VOICES] },
                }
              : {}),
            hashtags: { type: "array", items: { type: "string" } },
            energy: { type: "number" },
            anchors: {
              type: "object",
              properties: {
                head: { type: "array", items: { type: "number" } },
                nose: { type: "array", items: { type: "number" } },
                mouth: { type: "array", items: { type: "number" } },
                left_eye: { type: "array", items: { type: "number" } },
                right_eye: { type: "array", items: { type: "number" } },
                left_ear: { type: "array", items: { type: "number" } },
                right_ear: { type: "array", items: { type: "number" } },
                chest: { type: "array", items: { type: "number" } },
              },
              required: ["head", "mouth"],
            },
          },
          required: includeWriting
            ? ["breed", "mood", "personality", "monologue", "suggestedVoice", "anchors"]
            : ["breed", "mood", "personality", "anchors"],
        },
      }),
    });
  } catch {
    // fetch() rejects rather than returning a response when CORS blocks it, so
    // this branch is almost always a CORS or connectivity problem.
    throw new Error(
      "Could not reach Ollama Cloud. The /ollama-api rewrite must be configured on your host (see README)."
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");

    // "model not found" is the most common failure here, and the raw message
    // doesn't explain why: Cloud serves a small catalogue of large models, and
    // the popular local vision models simply aren't in it.
    if (response.status === 404 || /not found/i.test(text)) {
      throw new Error(
        `Ollama Cloud doesn't host "${model}". It serves a small catalogue of large models - qwen3-vl and llama3.2-vision are local-only and not available here. Open settings and pick from the discovered list; gemma4:31b is the lightest cloud vision option.`
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error("Ollama rejected the API key. Check it in settings.");
    }

    throw new Error(`Ollama error ${response.status}: ${text || response.statusText}`);
  }

  const data = await response.json();
  if (data.error) throw new Error(`Ollama error: ${data.error}`);

  const text = data?.message?.content;
  if (!text) throw new Error("Ollama returned an empty response.");

  const analysis = coerceAnalysis(JSON.parse(extractJSON(text)));
  if (includeWriting && !analysis.monologue) {
    throw new Error("Ollama returned no monologue.");
  }
  return analysis;
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */

/**
 * @param includeWriting  Ask the model to also write a monologue and pick a
 *   voice. False when the user is supplying their own script or recording.
 */
export async function analyzeDogImage(file: File | Blob, config: ApiKeys, includeWriting = true): Promise<DogAnalysis> {
  const provider: AiProvider = config.aiProvider ?? "gemini";

  if (provider === "ollama") {
    return analyzeWithOllama(file, config.ollamaModel || "gemma4:31b", config.ollamaKey ?? "", includeWriting);
  }

  return analyzeWithGemini(file, config.geminiKey, config.geminiModel || "gemini-flash-latest", includeWriting);
}

/** Whether the current settings are complete enough to attempt an analysis. */
export function hasVisionConfig(config: ApiKeys): boolean {
  if (config.aiProvider === "ollama") {
    return !!config.ollamaModel && !!config.ollamaKey;
  }
  return !!config.geminiKey;
}
