/**
 * Background plate construction.
 *
 * The background layer cannot just be the original photo, because the original
 * photo still contains the dog. The moment the cutout parallaxes away from its
 * starting position it uncovers its own twin sitting in the plate behind it -
 * a ghost that gets worse the more depth you add.
 *
 * So we erase the dog and fill the hole before anything else touches the
 * plate. The fill uses pull-push (a.k.a. push-pull) hole filling: repeatedly
 * halve the image, letting each downsample bleed surrounding colour inward,
 * then composite the coarse levels back underneath the fine ones so every
 * transparent pixel inherits colour from its nearest valid neighbours.
 *
 * This is the classic scattered-data approximation from Gortler et al.'s
 * lumigraph work, and it's a good fit here for one specific reason: the plate
 * gets heavily blurred afterwards anyway, so we need plausible low-frequency
 * colour, not plausible detail. Pull-push produces exactly that, using nothing
 * but `drawImage` and premultiplied alpha.
 */

/**
 * Canvas 2D premultiplies alpha when it downscales, which means a bilinear
 * halving already computes an alpha-weighted colour average - transparent
 * pixels contribute nothing rather than dragging the result toward black.
 * That's precisely the "pull" step, for free.
 */
function halve(source: HTMLCanvasElement): HTMLCanvasElement {
  const next = document.createElement("canvas");
  next.width = Math.max(1, Math.floor(source.width / 2));
  next.height = Math.max(1, Math.floor(source.height / 2));

  const ctx = next.getContext("2d");
  if (ctx) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(source, 0, 0, next.width, next.height);
  }

  return next;
}

/**
 * Grow the erased region slightly.
 *
 * Segmentation masks feather at the edges, so the outermost ring of "dog"
 * pixels is only partially transparent and keeps a halo of the dog's own
 * colour. Dilating the hole a few pixels throws that fringe away - cheaper and
 * more reliable than trying to unmix the edge.
 */
function dilateHole(
  ctx: CanvasRenderingContext2D,
  cutout: ImageBitmap,
  width: number,
  height: number,
  spreadPx: number
): void {
  ctx.globalCompositeOperation = "destination-out";

  // Eight offset stamps approximate a circular dilation well enough at these
  // radii, and cost eight draws instead of a per-pixel morphology pass.
  const offsets: [number, number][] = [
    [0, 0],
    [spreadPx, 0],
    [-spreadPx, 0],
    [0, spreadPx],
    [0, -spreadPx],
    [spreadPx * 0.7, spreadPx * 0.7],
    [-spreadPx * 0.7, spreadPx * 0.7],
    [spreadPx * 0.7, -spreadPx * 0.7],
    [-spreadPx * 0.7, -spreadPx * 0.7],
  ];

  for (const [dx, dy] of offsets) {
    ctx.drawImage(cutout, dx, dy, width, height);
  }

  ctx.globalCompositeOperation = "source-over";
}

export interface PlateOptions {
  /** Gaussian radius in pixels, expressed against a 1080px-wide reference. */
  blurPx: number;
  /** Whether to blur at all. `original` backgrounds want a sharp plate. */
  blur: boolean;
  /** Replaces the photo entirely. Drawn cover-fit at the source's size. */
  customImage?: ImageBitmap | null;
}

/**
 * Draw `image` cover-fit into a canvas matching the source photo's dimensions.
 *
 * Matching the source size matters more than it looks: every UV transform in
 * the shader is derived from the photo's aspect ratio, so a plate of the same
 * size drops straight in and needs no separate mapping.
 */
/**
 * Whether a value is something `drawImage` will actually accept.
 *
 * Guards against a deserialised `{}` masquerading as an ImageBitmap: it's
 * truthy, it passes a `!= null` check, and it throws a TypeError deep inside
 * canvas where the stack points at the renderer rather than at the config that
 * caused it.
 */
export function isDrawable(value: unknown): value is ImageBitmap {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as ImageBitmap).width === "number" &&
    typeof (value as ImageBitmap).height === "number" &&
    (value as ImageBitmap).width > 0
  );
}

function drawCoverFit(image: ImageBitmap, width: number, height: number, blurPx: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;

  const scale = Math.max(width / image.width, height / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;

  if (blurPx > 0) ctx.filter = `blur(${scaleRadius(blurPx, width)}px)`;
  ctx.drawImage(image, (width - dw) / 2, (height - dh) / 2, dw, dh);
  ctx.filter = "none";

  return canvas;
}

/**
 * Build the background plate: the photo with the dog removed, its hole filled,
 * and optionally blurred.
 *
 * Falls back to the plain photo when there's no cutout - there's nothing to
 * erase, and a ghost is impossible if the layers never separate.
 */
export function buildBackgroundPlate(
  source: ImageBitmap,
  cutout: ImageBitmap | null,
  options: PlateOptions
): HTMLCanvasElement {
  const width = source.width;
  const height = source.height;

  // A user-supplied background replaces the photo wholesale, so there's
  // nothing to erase and no hole to fill.
  //
  // The truthiness check has to be a real type check, not `if (customImage)`.
  // Background config is persisted to localStorage, and an ImageBitmap survives
  // JSON.stringify as `{}` — truthy, and fatal the moment drawImage sees it.
  // The config layer strips it on save now, but a plate that throws takes the
  // whole preview down with it, so this stays as a second line of defence.
  if (isDrawable(options.customImage)) {
    return drawCoverFit(options.customImage, width, height, options.blur ? options.blurPx : 0);
  }

  const output = document.createElement("canvas");
  output.width = width;
  output.height = height;
  const outCtx = output.getContext("2d");
  if (!outCtx) return output;

  if (!cutout) {
    if (options.blur) outCtx.filter = `blur(${scaleRadius(options.blurPx, width)}px)`;
    outCtx.drawImage(source, 0, 0);
    outCtx.filter = "none";
    return output;
  }

  /* --- 1. Punch the dog out ---------------------------------------- */
  const holed = document.createElement("canvas");
  holed.width = width;
  holed.height = height;
  const holeCtx = holed.getContext("2d");
  if (!holeCtx) return output;

  holeCtx.drawImage(source, 0, 0);
  dilateHole(holeCtx, cutout, width, height, Math.max(2, width * 0.006));

  /* --- 2. Pull: build the pyramid ----------------------------------- */
  const pyramid: HTMLCanvasElement[] = [holed];
  let current = holed;
  while (current.width > 2 && current.height > 2) {
    current = halve(current);
    pyramid.push(current);
  }

  /* --- 3. Push: composite coarse levels underneath fine ones --------- *
   * `destination-over` paints only where the target is transparent, so
   * each level fills its own holes from the level above without touching
   * pixels that already hold real photo data.                           */
  for (let i = pyramid.length - 1; i > 0; i--) {
    const target = pyramid[i - 1];
    const ctx = target.getContext("2d");
    if (!ctx) continue;

    ctx.globalCompositeOperation = "destination-over";
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(pyramid[i], 0, 0, target.width, target.height);
    ctx.globalCompositeOperation = "source-over";
  }

  /* --- 4. Blur onto an opaque plate --------------------------------- */
  if (options.blur) {
    outCtx.filter = `blur(${scaleRadius(options.blurPx, width)}px)`;
  }
  outCtx.drawImage(pyramid[0], 0, 0);
  outCtx.filter = "none";

  return output;
}

/**
 * Scale the blur radius to the image.
 *
 * A fixed pixel radius reads as a heavy blur on a 600px photo and as barely
 * anything on a 4000px one, so the setting has to mean the same thing
 * relative to the frame rather than in absolute pixels.
 */
function scaleRadius(blurPx: number, width: number): number {
  return Math.max(1, (blurPx * width) / 1080);
}
