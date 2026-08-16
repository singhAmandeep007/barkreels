/**
 * Client-side subject isolation.
 *
 * Runs ISNet (a dichotomous image-segmentation network) through ONNX Runtime
 * Web to split the dog from its background. Nothing leaves the browser.
 *
 * Cost: the weights are fetched once (~22MB for fp16) and cached by the
 * browser's HTTP cache thereafter. We surface that as real progress rather
 * than a mystery spinner, because a silent 22MB download on a phone feels
 * exactly like a hang.
 *
 * The payoff is that the dog and the background become independently
 * transformable, which is what makes parallax, replaced backgrounds, and
 * body roll possible at all - you cannot roll a dog that is welded to its
 * own backyard.
 */

import type { DogAnchors, LayerSet, NormBox } from "../types";

/**
 * Loaded on demand rather than at module scope.
 *
 * A static import pulls ~390kB of ONNX Runtime glue into the main bundle,
 * which every visitor would pay for on first paint - including the ones who
 * bounce off the landing page without uploading anything. Deferring it to the
 * moment segmentation is actually requested keeps the initial load lean, and
 * the dynamic import is cached after the first call.
 */
type BgModule = typeof import("@imgly/background-removal");
let modulePromise: Promise<BgModule> | null = null;

function loadModule(): Promise<BgModule> {
  modulePromise ??= import("@imgly/background-removal");
  return modulePromise;
}

export interface SegmentationProgress {
  /** 0..1 across the whole operation. */
  fraction: number;
  label: string;
}

type ProgressFn = (p: SegmentationProgress) => void;

/**
 * fp16 halves the download versus full-precision ISNet with no visible quality
 * loss at the resolutions we render. quint8 is smaller still but its masks get
 * blocky around fur, which is precisely the edge detail that sells a cutout.
 */
const MODEL = "isnet_fp16" as const;

let preloaded = false;

/** Warm the model cache ahead of time - e.g. while the user is still typing. */
export async function preloadSegmenter(onProgress?: ProgressFn): Promise<void> {
  if (preloaded) return;
  try {
    const { preload } = await loadModule();
    await preload({
      model: MODEL,
      device: "gpu",
      progress: (key: string, current: number, total: number) => {
        onProgress?.({
          fraction: total > 0 ? current / total : 0,
          label: describeProgressKey(key),
        });
      },
    });
    preloaded = true;
  } catch (err) {
    // A failed preload is not fatal; removeBackground will retry the fetch.
    console.warn("Segmenter preload failed, will retry on demand:", err);
  }
}

function describeProgressKey(key: string): string {
  if (key.startsWith("fetch")) return "Downloading segmentation model…";
  if (key.startsWith("compute")) return "Isolating your dog…";
  return "Preparing…";
}

/**
 * Tight bounding box of pixels above an alpha threshold.
 *
 * We sample on a stride rather than reading every pixel: at 1080p that's a
 * 4-megapixel scan otherwise, and we only need the box to a few pixels of
 * accuracy for anchor placement.
 */
function computeAlphaBox(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = 24,
  stride = 2
): NormBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += stride) {
    const rowOffset = y * width * 4;
    for (let x = 0; x < width; x += stride) {
      if (data[rowOffset + x * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) return null;

  return {
    x: minX / width,
    y: minY / height,
    w: (maxX - minX) / width,
    h: (maxY - minY) / height,
  };
}

/**
 * Segment one photo into a `LayerSet`.
 *
 * Falls back to source-only (no cutout) rather than throwing: a dog that
 * animates without depth beats an error screen, and the renderer already
 * handles a null cutout.
 */
export async function segmentImage(file: File | Blob, onProgress?: ProgressFn): Promise<LayerSet> {
  const sourceBitmap = await createImageBitmap(file instanceof File ? file : new Blob([file]));

  const width = sourceBitmap.width;
  const height = sourceBitmap.height;

  try {
    const { removeBackground } = await loadModule();
    const cutoutBlob = await removeBackground(file, {
      model: MODEL,
      device: "gpu",
      output: { format: "image/png", quality: 1 },
      progress: (key: string, current: number, total: number) => {
        onProgress?.({
          fraction: total > 0 ? current / total : 0,
          label: describeProgressKey(key),
        });
      },
    });

    const cutout = await createImageBitmap(cutoutBlob);

    // Read alpha back on an OffscreenCanvas so we can derive anchor fallbacks
    // without blocking on another network round trip.
    const canvas = new OffscreenCanvas(cutout.width, cutout.height);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    let cutoutBox: NormBox | null = null;
    if (ctx) {
      ctx.drawImage(cutout, 0, 0);
      const imageData = ctx.getImageData(0, 0, cutout.width, cutout.height);
      cutoutBox = computeAlphaBox(imageData.data, cutout.width, cutout.height);
    }

    return { source: sourceBitmap, cutout, cutoutBox, width, height };
  } catch (err) {
    console.warn("Segmentation failed, falling back to flat render:", err);
    return {
      source: sourceBitmap,
      cutout: null,
      cutoutBox: null,
      width,
      height,
    };
  }
}

/**
 * Build usable anchors when the vision model didn't return coordinates.
 *
 * These are proportional estimates from canine facial geometry rather than
 * anything learned: on a typical head-on dog portrait the muzzle sits in the
 * lower-middle third of the subject and the eyes sit at roughly 30% height.
 * Crude, but it degrades gracefully - a slightly misplaced jaw pivot reads as
 * a head bob rather than as a glitch, whereas no anchors at all means no
 * mouth movement whatsoever.
 */
export function deriveAnchors(box: NormBox | null): DogAnchors {
  // Whole-frame default when we have neither a mask nor a model answer.
  const b: NormBox = box ?? { x: 0.15, y: 0.1, w: 0.7, h: 0.8 };

  const head: NormBox = {
    x: b.x + b.w * 0.18,
    y: b.y,
    w: b.w * 0.64,
    h: b.h * 0.46,
  };

  const nose: NormBox = {
    x: head.x + head.w * 0.36,
    y: head.y + head.h * 0.54,
    w: head.w * 0.28,
    h: head.h * 0.16,
  };

  const mouth: NormBox = {
    x: head.x + head.w * 0.3,
    y: nose.y + nose.h,
    w: head.w * 0.4,
    h: head.h * 0.22,
  };

  const eyeW = head.w * 0.16;
  const eyeH = head.h * 0.12;
  const eyeY = head.y + head.h * 0.3;

  // Ears sit on the outer top corners of the skull and extend above it. The
  // negative y offset is deliberate: on most breeds the ear tips clear the
  // top of the head box the model reports.
  const earW = head.w * 0.26;
  const earH = head.h * 0.42;
  const earY = head.y - head.h * 0.1;

  return {
    head,
    mouth,
    nose,
    leftEye: { x: head.x + head.w * 0.2, y: eyeY, w: eyeW, h: eyeH },
    rightEye: { x: head.x + head.w * 0.64, y: eyeY, w: eyeW, h: eyeH },
    leftEar: { x: head.x - earW * 0.15, y: earY, w: earW, h: earH },
    rightEar: { x: head.x + head.w - earW * 0.85, y: earY, w: earW, h: earH },
    chest: { x: b.x + b.w * 0.5, y: b.y + b.h * 0.72 },
  };
}

/**
 * Where the mandible hinges, in normalised y.
 *
 * Vision models are asked for the mouth *line* but reliably return the whole
 * muzzle - nose included - because on an animal "mouth" colloquially means the
 * snout. Measured on real responses, the returned box routinely starts at the
 * top of the nose, which put the peak of a centre-weighted warp squarely on the
 * nose leather. A dog's nose does not move when it talks; this looked wrong in
 * exactly the way people notice.
 *
 * So we don't trust the box's top edge. The hinge is pushed below the nose
 * whenever we know where the nose is, and otherwise sits in the lower part of
 * the reported box on the assumption that it's a muzzle.
 */
export function jawHingeY(anchors: DogAnchors): number {
  const mouthTop = anchors.mouth.y;
  const mouthBottom = anchors.mouth.y + anchors.mouth.h;

  if (anchors.nose) {
    const noseBottom = anchors.nose.y + anchors.nose.h;
    // Just under the nose, but never so low there's no jaw left to move.
    return Math.min(noseBottom, mouthBottom - anchors.mouth.h * 0.25);
  }

  // No nose reported: assume the box is a muzzle and hinge at 55% down it.
  // That lands near the lip line on both a long snout and a flat face.
  return mouthTop + anchors.mouth.h * 0.55;
}

/**
 * Prefer model-supplied anchors, but repair any that are missing or absurd.
 * Vision models occasionally return boxes with zero area or coordinates
 * outside the frame, and a degenerate mouth box would divide by zero in the
 * warp shader.
 */
export function reconcileAnchors(fromModel: DogAnchors | null, fromMask: DogAnchors): DogAnchors {
  if (!fromModel) return fromMask;

  const valid = (box: NormBox | null): boolean =>
    !!box &&
    box.w > 0.01 &&
    box.h > 0.01 &&
    box.x >= -0.1 &&
    box.y >= -0.1 &&
    box.x + box.w <= 1.1 &&
    box.y + box.h <= 1.1;

  return {
    head: valid(fromModel.head) ? fromModel.head : fromMask.head,
    mouth: valid(fromModel.mouth) ? fromModel.mouth : fromMask.mouth,
    nose: valid(fromModel.nose) ? fromModel.nose : fromMask.nose,
    leftEye: valid(fromModel.leftEye) ? fromModel.leftEye : fromMask.leftEye,
    rightEye: valid(fromModel.rightEye) ? fromModel.rightEye : fromMask.rightEye,
    leftEar: valid(fromModel.leftEar) ? fromModel.leftEar : fromMask.leftEar,
    rightEar: valid(fromModel.rightEar) ? fromModel.rightEar : fromMask.rightEar,
    chest:
      fromModel.chest &&
      fromModel.chest.x >= 0 &&
      fromModel.chest.x <= 1 &&
      fromModel.chest.y >= 0 &&
      fromModel.chest.y <= 1
        ? fromModel.chest
        : fromMask.chest,
  };
}
