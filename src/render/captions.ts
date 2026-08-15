/**
 * Caption rendering.
 *
 * Drawn with the 2D canvas API on top of the WebGL output rather than inside
 * the shader. Two reasons: text metrics and word wrapping are miserable in
 * GLSL, and compositing a caption texture would mean uploading ~8MB per frame
 * at 1080x1920. A `drawImage` of the GL canvas plus native text calls is both
 * simpler and faster.
 *
 * Like everything else in the render path, `drawCaptions` is a pure function
 * of time - it derives the active word by binary-searching the timestamp list
 * rather than tracking a cursor between calls.
 */

import type { CaptionConfig, WordTimestamp } from "../types";

/**
 * Index of the word being spoken at time `t`, or the most recent one during
 * inter-word gaps so captions don't flicker off between syllables.
 * Binary search because at 30fps over a 30s clip this runs ~900 times per
 * export and the word list can be long.
 */
export function findActiveWord(words: WordTimestamp[], t: number): number {
  if (words.length === 0) return -1;
  if (t < words[0].start) return -1;

  let lo = 0;
  let hi = words.length - 1;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start <= t) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

interface LaidOutWord {
  word: WordTimestamp;
  index: number;
  x: number;
  width: number;
}

interface LaidOutLine {
  words: LaidOutWord[];
  width: number;
}

/**
 * Greedy word wrap over the visible window.
 *
 * Measured with the *unhighlighted* font throughout, deliberately: the active
 * word renders larger, but if layout accounted for that the whole line would
 * reflow on every word change and the caption would visibly jitter. Letting
 * the highlighted word overflow its measured slot slightly is far less
 * noticeable than text that shuffles sideways five times a second.
 */
function layoutLines(words: LaidOutWord[], maxWidth: number, spaceWidth: number): LaidOutLine[] {
  const lines: LaidOutLine[] = [];
  let current: LaidOutWord[] = [];
  let width = 0;

  for (const item of words) {
    const advance = current.length === 0 ? item.width : spaceWidth + item.width;
    if (width + advance > maxWidth && current.length > 0) {
      lines.push({ words: current, width });
      current = [item];
      width = item.width;
    } else {
      current.push(item);
      width += advance;
    }
  }

  if (current.length > 0) lines.push({ words: current, width });
  return lines;
}

function fontFor(size: number, weight = 900): string {
  return `${weight} ${size}px Inter, "Helvetica Neue", Arial, sans-serif`;
}

/**
 * Draw the caption block for time `t`.
 *
 * `ctx` is expected to already contain the rendered video frame.
 */
export function drawCaptions(
  ctx: CanvasRenderingContext2D,
  words: WordTimestamp[],
  t: number,
  config: CaptionConfig,
  width: number,
  height: number
): void {
  if (!config.enabled || words.length === 0) return;

  const activeIndex = findActiveWord(words, t);
  if (activeIndex < 0) return;

  const baseSize = height * config.sizeRatio;
  const lineHeight = baseSize * 1.28;
  const maxWidth = width * 0.84;

  ctx.save();
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.font = fontFor(baseSize);

  const spaceWidth = ctx.measureText(" ").width;

  /* --- Choose the visible window --------------------------------- */
  let start: number;
  let end: number;

  if (config.style === "popup") {
    // Two words at a time, hard-cut. Reads as punchy meme captioning.
    start = activeIndex - (activeIndex % 2);
    end = Math.min(words.length - 1, start + 1);
  } else if (config.style === "minimal") {
    // Whole sentence: back up to the last terminator, forward to the next.
    start = activeIndex;
    while (start > 0 && !/[.!?]$/.test(words[start - 1].word)) start--;
    end = activeIndex;
    while (end < words.length - 1 && !/[.!?]$/.test(words[end].word)) end++;
  } else {
    // Karaoke: a rolling window that keeps the active word off the edges.
    const half = Math.floor(config.windowSize / 2);
    start = Math.max(0, activeIndex - half);
    end = Math.min(words.length - 1, start + config.windowSize - 1);
    start = Math.max(0, end - config.windowSize + 1);
  }

  const visible: LaidOutWord[] = [];
  for (let i = start; i <= end; i++) {
    const text = config.uppercase ? words[i].word.toUpperCase() : words[i].word;
    visible.push({
      word: { ...words[i], word: text },
      index: i,
      x: 0,
      width: ctx.measureText(text).width,
    });
  }

  const lines = layoutLines(visible, maxWidth, spaceWidth);

  /* --- Draw ------------------------------------------------------- */
  const blockHeight = lines.length * lineHeight;
  let y = height * config.positionY - blockHeight / 2 + lineHeight / 2;

  for (const line of lines) {
    let x = (width - line.width) / 2;

    for (let i = 0; i < line.words.length; i++) {
      const item = line.words[i];
      const isActive = item.index === activeIndex;
      const isSpoken = item.index < activeIndex;

      // Pop the active word using an ease-out on its elapsed fraction: it
      // snaps to full size in the first ~90ms then holds, which lands on the
      // consonant instead of drifting behind the audio.
      let scale = 1;
      if (isActive) {
        const dur = Math.max(0.06, item.word.end - item.word.start);
        const p = Math.min(1, (t - item.word.start) / Math.min(0.09, dur));
        scale = 1 + 0.16 * (1 - Math.pow(1 - p, 3));
      }

      const size = baseSize * scale;
      ctx.font = fontFor(size);

      const cx = x + item.width / 2;

      // Stroke first, then fill: an outline drawn over the glyph would eat
      // into the letterforms and make small text look bolder than it is.
      ctx.lineJoin = "round";
      ctx.miterLimit = 2;
      ctx.lineWidth = size * 0.18;
      ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";

      ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
      ctx.shadowBlur = size * 0.22;
      ctx.shadowOffsetY = size * 0.06;

      ctx.textAlign = "center";
      ctx.strokeText(item.word.word, cx, y);

      ctx.shadowColor = "transparent";
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;

      if (isActive) {
        ctx.fillStyle = config.highlightColor;
      } else if (isSpoken) {
        ctx.fillStyle = config.textColor;
      } else {
        // Upcoming words sit back at 55% so the eye tracks the highlight
        // rather than reading ahead.
        ctx.fillStyle = withAlpha(config.textColor, 0.55);
      }

      ctx.fillText(item.word.word, cx, y);

      ctx.font = fontFor(baseSize);
      x += item.width + spaceWidth;
    }

    y += lineHeight;
  }

  ctx.restore();
}

function withAlpha(color: string, alpha: number): string {
  const hex = color.replace("#", "");
  if (hex.length !== 6) return color;
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
