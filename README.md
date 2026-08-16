# BarkReels 🐕 - client-only AI dog video generator

Upload a photo of your dog. Get back a vertical short-form video where they
talk, breathe, blink, and nod - with burned-in subtitles and a real MP4 at the
end. Every pixel is rendered in your browser. There is no backend.

Built for the [DEV Weekend Challenge: Dog Days Edition](https://dev.to/challenges/weekend-2026-08-13).

---

## How it works

```
photo ──┬─→ vision model ──→ breed / mood / monologue / facial anchors
        └─→ ISNet (ONNX, in-browser) ──→ dog cutout + alpha

monologue ──→ ElevenLabs ──→ audio + word timestamps
                               │
                               ├─→ RMS envelope (asymmetric smoothing)
                               └─→ subtitle timing

envelope + anchors + cutout ──→ animation rig ──→ WebGL warp ──→ frames
                                                                  │
                                          WebCodecs H.264 + AAC ──┴──→ MP4
```

### The one architectural rule

`renderFrame(t)` is a **pure function of time**. It reads no clock, consults no
playback state, and mutates nothing that affects a later call.

That single constraint is what makes the rest work:

- **Preview** is `requestAnimationFrame(() => renderFrame(audio.currentTime))`
- **Export** is `for (frame = 0; frame < total; frame++) renderFrame(frame / fps)`

Same code path, same pixels. Export doesn't run in real time, so no frame is
ever dropped, backgrounding the tab can't corrupt the output, and encoding
typically finishes **2–3× faster than playback**.

Two things in the rig are genuinely stateful - the emphasis-nod spring and the
blink schedule. Both are integrated up front into lookup tables, which converts
them back into pure sample-by-time. Blinks use a seeded PRNG rather than
`Math.random()`, so the video you export is the video you previewed.

---

## The animation formula

Perceived aliveness comes from layering cheap signals correctly, not from an
expensive model. Everything below is in `src/render/rig.ts`.

| Signal           | Formula                                                         | Why                                                                                                                                                                  |
| ---------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Jaw**          | `jawMax · smoothstep(0.08, 0.55, E)^0.75`                       | Gated and compressive. A linear map tracks loudness like a VU meter and reads as mechanical.                                                                         |
| **Envelope `E`** | one-pole, `τ_attack = 15ms`, `τ_release = 90ms`                 | **The single highest-impact detail.** Muscles snap a jaw open; tissue eases it closed. Symmetric smoothing flutters shut between syllables.                          |
| **Breathing**    | `1 + 0.012·sin(2π · 0.28t)`                                     | ~17 breaths/min, scaling about the chest.                                                                                                                            |
| **Head sway**    | `A·(sin(2π·0.37t) + 0.5·sin(2π·0.61t + 1.1))`                   | Two **incommensurable** frequencies. A single sine has a period the eye locks onto within three cycles; an irrational ratio never repeats inside a clip.             |
| **Emphasis nod** | `nod'' = −k·nod − c·nod'`, kicked by onset impulses, `ζ = 0.55` | Underdamped so the head overshoots exactly once and settles - a real neck absorbing an impulse. `ζ = 1` looks sedated; `ζ > 0.7` looks like a bobblehead.            |
| **Blink**        | Poisson `λ = 1/3.5s`, close 60ms / open 140ms                   | Asymmetric. Uniform-interval blinking is one of the strongest "this is a puppet" tells.                                                                              |
| **Ears**         | Poisson flicks, `sin(2.5πp)·e^(−4.2p)`, hinged at the skull     | Rotated about the ear base with a lever weight, not translated - a translated ear drags scalp along with it. Seeded separately per side so they never fire together. |
| **Camera**       | eased Ken Burns + 2 octaves of value noise                      | Band-limited noise reads as a handheld operator; white noise reads as compression artefacts.                                                                         |
| **Parallax**     | `bg = −0.35 · subject displacement`                             | Counter-motion is the cheapest convincing depth cue there is.                                                                                                        |

Two details worth stealing:

1. **An emphasis is an impulse, not a force.** Applying the onset as a sustained
   force for one timestep delivers 1/240th of the momentum and the head barely
   twitches - this cost me a 40× bug. Kick the _velocity_ instead.
2. **Peak-pick your onsets with a refractory period** (~120ms). The raw
   derivative spikes on every syllable edge; feeding it in directly gives you
   either nothing or a permanent jitter.

Presets are just different points in the same coefficient space, not separate
code paths - ordered least to most motion:

`Locked Off` · `Barely There` · `Portrait` · `Belly Roll` · `Bouncy` · `Zoomies`

**`Locked Off` is the default, and it's the most convincing.** The frame, the
camera and the body hold completely still; only the mouth, eyes and ears move.
That's counterintuitive until you notice that _motion_ is what gives away a
puppeted photo. Hold everything still and the viewer reads it as real video of a
dog sitting calmly, leaving only the mouth to judge - and the mouth is the one
part driven by real audio.

---

## Deformation

Facial animation is an **inverse warp in the fragment shader**: for each output
pixel we ask "which source pixel belongs here", rather than pushing a vertex
mesh around. Fewer moving parts than a mesh rig, resolution-independent, and it
makes each effect local and composable - jaw and blink just perturb the lookup
coordinate inside their own falloff.

### The jaw is hinged, not radial

Vision models are asked for the mouth _line_ and reliably return the whole
**muzzle** - nose included - because on an animal "mouth" colloquially means the
snout. Measured on real Gemini responses, the returned box starts at the top of
the nose on both a beagle and a pug.

The first implementation gated the warp to "roughly the lower part" of that box
with a `smoothstep`. It ramped in too early: on the beagle the bottom half of
the **nose leather** took up to **0.50** of full jaw displacement and visibly
stretched downward. A flat-faced pug barely showed it, so the bug was
geometry-dependent - the worst kind to tune your way out of.

The fix is structural rather than tuned. Ask for `nose` as its own anchor,
derive a hinge below it, and give the shader a hard boundary:

```glsl
float below = uv.y - u_jawHinge;
if (below <= 0.0) return uv;   // nose, eyes, forehead: untouched, always
```

Displacement then grows with distance _below_ the hinge, so the chin travels
furthest and the corners barely move - which is what a mandible actually does.
Peak warp on the nose drops from 0.502 to 0.106 on the beagle and to exactly
zero on the pug, with no per-breed constants.

A tuned gate encodes "probably the lower part". A hinge encodes anatomy, and it
holds for a pug and a greyhound alike.

Anchors (muzzle, eyes, ears, chest) come from the vision model as normalised
boxes.
When it declines to cooperate, `deriveAnchors` synthesises estimates from the
alpha mask's bounding box using canine facial proportions - crude, but it
degrades to a head bob rather than a glitch.

---

## Avoiding silhouette ghosting

Two independent bugs both produce a displaced copy of the dog, and fixing one
still leaves the other visible:

1. **A fake contact shadow.** Sampling the cutout's alpha at an offset and
   darkening the background with it is, by construction, an offset copy of the
   whole silhouette. Removed - real contact shadows pool on the ground, and most
   inputs here are head-and-shoulders portraits with no ground in frame.

2. **The background plate still contained the dog.** The blurred background was
   a blur of the _whole photo_. The moment the cutout parallaxed away from its
   starting position it uncovered its own blurred twin. This one gets worse the
   more depth you add, so it punishes exactly the feature it's attached to.

The fix for (2) is `render/backgroundPlate.ts`: erase the dog, dilate the hole a
few pixels to throw away the mask's feathered fringe, then fill it by
**pull-push** - halve the image repeatedly (canvas premultiplies alpha, so a
bilinear downscale _is_ an alpha-weighted average and holes bleed inward for
free), then composite the coarse levels back underneath the fine ones with
`destination-over`.

It's a scattered-data approximation, and it works here precisely because the
plate gets heavily blurred afterwards: we need plausible low-frequency colour,
not plausible detail.

---

## Setup

```bash
npm install
npm run dev
```

Then click **Set API keys** in the header.

### ElevenLabs (required)

Get a key from the [quickstart](https://elevenlabs.io/docs/eleven-api/quickstart).
Called directly from the browser - the API returns `access-control-allow-origin: *`.

Used for the voiceover _and_ its character-level timestamps, which drive both
the subtitles and the mouth animation.

### Vision model (pick one)

**Google Gemini** - get a key at [aistudio.google.com/apikey](https://aistudio.google.com/apikey).

**Ollama Cloud** - get a key at
[ollama.com/settings/keys](https://ollama.com/settings/keys).

Cloud only; there is no local-instance mode. The model list is discovered from
`/api/tags` at runtime rather than hardcoded, and filtered to vision-capable
models - Cloud serves a small catalogue of large models, and the popular local
vision models (`qwen3-vl`, `llama3.2-vision`) are **not** in it. `gemma4:31b`
is the lightest cloud vision option and the default.

#### Why Ollama Cloud needs a rewrite

`ollama.com` returns **405 on `OPTIONS` and sends no CORS headers**, so the
browser refuses the preflight for any authenticated JSON POST. The app routes
cloud traffic through a same-origin `/ollama-api` path instead:

- **dev** - proxied in `vite.config.ts`
- **Netlify** - `public/_redirects`
- **Vercel** - `vercel.json`

Both are pure host config with no server code, so the "client-side only" claim
survives deployment.

---

## Export

Primary path is **WebCodecs + [Mediabunny](https://mediabunny.dev)** → H.264 in
a real MP4 with `fastStart` (moov atom up front, which every social platform
expects). AAC audio, muxed client-side.

`mp4-muxer` is deprecated and folded into Mediabunny; this uses Mediabunny.

Browsers without WebCodecs fall back to real-time `MediaRecorder` → WebM. The
app says so rather than handing you a mislabelled file.

Formats: MP4 / WebM · 1080×1920, 720×1280, 1080×1080 · 24–60fps.

---

## Segmentation cost

First run downloads **~22MB** of ISNet fp16 weights (fp16 halves full-precision
with no visible quality loss at these resolutions; quint8 is smaller but its
masks go blocky around fur, which is exactly the detail that sells a cutout).

Inference is ~4s on an M2, 9–12s on mid-range Android. The app warms the
download in the background the moment a photo lands, so it overlaps with the
vision API call rather than being dead air.

Segmentation failure is non-fatal - it falls back to warping the flat photo.

---

## Stack

React 19 · TypeScript · Vite · TailwindCSS v4 · WebGL2 · WebCodecs ·
Mediabunny · ONNX Runtime Web · ElevenLabs · Gemini / Ollama

## Project layout

```
src/
  render/
    rig.ts           the animation formula (pure)
    glRenderer.ts    WebGL2 layered renderer, renderFrame(t)
    captions.ts      2D caption layout and drawing
    exporter.ts      offline WebCodecs encode + muxing
  services/
    vision.ts        Gemini / Ollama behind one interface
    elevenlabs.ts    TTS with word timestamps
    segmentation.ts  ISNet cutout + anchor fallbacks
    audioAnalysis.ts envelope, onsets, PCM decode
  components/        UI
  devtest.ts         dev-only render harness (not in the production build)
```

### Render harness

`npm run dev` then open `/devtest.html`. Exercises the full render and export
path with synthetic speech-like audio - no API keys, no credits burned. Checks
envelope range, onset peaks, rig ranges, determinism, per-frame cost, and that
the exported file really is ISOBMFF.

## License

MIT
