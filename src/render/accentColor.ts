/**
 * Pull a caption colour out of the photo.
 *
 * A brown dog wants warm captions; a pink collar wants pink. Sampling the
 * subject rather than picking a fixed brand colour makes the text look like it
 * belongs to the image instead of being stamped on top of it.
 *
 * Two things make this harder than "find the most common colour":
 *
 *   1. The most common colour on a dog is almost always a desaturated brown or
 *      grey. It's accurate and it's a terrible caption colour. We deliberately
 *      weight *saturation* so a small pink collar can outvote a large beige
 *      body - small saturated accents are exactly what reads as intentional.
 *
 *   2. Captions sit on a dark stroke over arbitrary imagery, so the colour has
 *      to stay legible. We clamp lightness into a band rather than using the
 *      raw sample, which would hand back near-black on a black pug.
 */

import type { NormBox } from "../types";

/* ------------------------------------------------------------------ *
 * Colour space
 * ------------------------------------------------------------------ */

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;

  if (d === 0) return [0, 0, l];

  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);

  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;

  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r: number, g: number, b: number;
  if (s === 0) {
    r = g = b = l;
  } else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }

  const to = (v: number) =>
    Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

/* ------------------------------------------------------------------ *
 * Extraction
 * ------------------------------------------------------------------ */

/** 24 hue buckets - 15° each, fine enough to separate pink from red. */
const HUE_BUCKETS = 24;

export interface AccentPalette {
  /** Best caption highlight: vivid and legible. */
  highlight: string;
  /** A softer companion, for secondary text or a solid background. */
  soft: string;
  /** Every candidate found, most prominent first - offered as swatches. */
  swatches: string[];
}

/**
 * Sample an image (optionally restricted to the subject's alpha) and return
 * caption-ready colours.
 *
 * Sampling is strided rather than exhaustive: at 4MP a full scan is pointless
 * when we only need a hue histogram, and stride 4 still gives ~250k samples.
 */
export function extractAccentPalette(
  source: ImageBitmap,
  cutout: ImageBitmap | null,
  box: NormBox | null
): AccentPalette {
  const fallback: AccentPalette = {
    highlight: "#FFD84D",
    soft: "#FFFFFF",
    swatches: ["#FFD84D", "#FF7A59", "#5AC8FA", "#FFFFFF"],
  };

  // Prefer the cutout: it excludes the background, so a beige wall behind a
  // black dog can't win the vote.
  const image = cutout ?? source;
  const w = Math.min(image.width, 512);
  const h = Math.round((w / image.width) * image.height);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return fallback;

  ctx.drawImage(image, 0, 0, w, h);

  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return fallback;
  }

  // Restrict to the subject when we know where it is.
  const x0 = box ? Math.floor(box.x * w) : 0;
  const x1 = box ? Math.ceil((box.x + box.w) * w) : w;
  const y0 = box ? Math.floor(box.y * h) : 0;
  const y1 = box ? Math.ceil((box.y + box.h) * h) : h;

  const weight = new Float64Array(HUE_BUCKETS);
  const satSum = new Float64Array(HUE_BUCKETS);
  const lightSum = new Float64Array(HUE_BUCKETS);
  const count = new Float64Array(HUE_BUCKETS);

  const stride = 4;

  for (let y = y0; y < y1; y += stride) {
    for (let x = x0; x < x1; x += stride) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 200) continue; // background or feathered edge

      const [hue, sat, light] = rgbToHsl(data[i], data[i + 1], data[i + 2]);

      // Skip near-black and near-white: they carry no usable hue, and on a
      // black pug or a white studio backdrop they'd otherwise dominate.
      if (light < 0.12 || light > 0.94) continue;
      if (sat < 0.12) continue;

      const bucket = Math.min(HUE_BUCKETS - 1, Math.floor(hue * HUE_BUCKETS));

      // Saturation squared: strongly favours vivid accents over large muted
      // areas. This is the line that lets a pink collar beat a beige body.
      weight[bucket] += sat * sat;
      satSum[bucket] += sat;
      lightSum[bucket] += light;
      count[bucket] += 1;
    }
  }

  const ranked = Array.from({ length: HUE_BUCKETS }, (_, i) => i)
    .filter((i) => count[i] > 0)
    .sort((a, b) => weight[b] - weight[a]);

  if (ranked.length === 0) return fallback;

  const toCaptionColor = (bucket: number, vivid: boolean): string => {
    const hue = (bucket + 0.5) / HUE_BUCKETS;
    const sat = satSum[bucket] / count[bucket];
    const light = lightSum[bucket] / count[bucket];

    return hslToHex(
      hue,
      // Push toward vivid; a caption in the dog's literal average saturation
      // looks washed out against the black stroke behind it.
      Math.min(1, Math.max(vivid ? 0.72 : 0.42, sat * 1.5)),
      // Clamp into a legible band. Below ~0.55 it disappears into the stroke,
      // above ~0.82 it glows and loses its hue.
      Math.min(0.82, Math.max(vivid ? 0.62 : 0.74, light))
    );
  };

  const swatches = ranked.slice(0, 4).map((b) => toCaptionColor(b, true));

  return {
    highlight: swatches[0],
    soft: toCaptionColor(ranked[0], false),
    // Always offer the neutral default too, so the sampled colours are a
    // suggestion rather than something the user has to fight.
    swatches: [...swatches, "#FFD84D", "#FFFFFF"],
  };
}
