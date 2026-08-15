/**
 * The renderer.
 *
 * Draws one frame of the video for an arbitrary time `t`. The contract that
 * matters: `renderFrame(t)` reads no clock, consults no playback state, and
 * mutates nothing that affects a later call. Given the same inputs it paints
 * the same pixels, whether it's being driven by requestAnimationFrame for the
 * live preview or hammered in a tight loop by the exporter at 8x real time.
 *
 * Pipeline per frame:
 *
 *   1. Evaluate the rig            → RigState (pure, see rig.ts)
 *   2. WebGL pass on an offscreen  → background + warped dog
 *   3. 2D pass on the output       → blit the GL result, then captions
 *
 * The split exists because text is painful in GLSL and re-uploading a caption
 * texture every frame would cost more than the entire GL pass.
 *
 * Deformation is done as an *inverse* warp in the fragment shader: for each
 * output pixel we ask "which source pixel belongs here", rather than pushing a
 * vertex mesh around. That's fewer moving parts than a mesh rig, it's
 * resolution-independent, and it makes the jaw and blink effects local and
 * composable - each one just perturbs the lookup coordinate inside its own
 * falloff region.
 */

import type {
  BackgroundConfig,
  CaptionConfig,
  DogAnchors,
  LayerSet,
  RigConfig,
  RigState,
  WordTimestamp,
  AudioEnvelope,
} from "../types";
import { evaluateRig, buildRigTables, type RigTables } from "./rig";
import { drawCaptions } from "./captions";

/* ------------------------------------------------------------------ *
 * Shaders
 * ------------------------------------------------------------------ */

const VERT = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  // Canvas-space UV with y running downwards, matching image convention.
  v_uv = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision highp float;

in vec2 v_uv;
out vec4 outColor;

uniform sampler2D u_source;   // full photo (background duty)
uniform sampler2D u_cutout;   // dog with alpha
uniform sampler2D u_blurred;  // pre-blurred photo

uniform float u_hasCutout;
uniform float u_aspect;       // canvasWidth / canvasHeight
uniform float u_time;

// Cover-fit mapping from canvas UV to texture UV.
uniform vec2 u_texScale;
uniform vec2 u_texOffset;

// Rig state
uniform float u_zoom;
uniform float u_tilt;
uniform float u_roll;
uniform float u_breath;
uniform float u_hop;
uniform float u_jaw;
uniform float u_blink;
uniform float u_energy;
uniform vec2  u_translate;
uniform vec2  u_bgShift;

// Anchors, in texture space
uniform vec4 u_mouthBox;   // x, y, w, h
uniform vec4 u_leftEye;
uniform vec4 u_rightEye;
uniform vec2 u_chest;

// Background
uniform int   u_bgMode;    // 0 original, 1 blur, 2 sunset, 3 studio, 4 park, 5 neon, 6 solid
uniform vec3  u_bgColor;
uniform float u_bgReactive;

const float PI = 3.14159265359;

/* Rotation has to happen in a square space, otherwise a 9:16 canvas shears
   the image instead of turning it. */
vec2 toSquare(vec2 p) { return vec2(p.x * u_aspect, p.y); }
vec2 fromSquare(vec2 p) { return vec2(p.x / u_aspect, p.y); }

vec2 rotate(vec2 p, float a) {
  float s = sin(a), c = cos(a);
  return vec2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), u.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), u.x), u.y);
}

/* ---------------------------------------------------------------- *
 * Local deformations (inverse: we move the *lookup*, not the pixels)
 * ---------------------------------------------------------------- */

/* Jaw.
   Inside an ellipse around the muzzle, pull the sample point upwards so the
   pixels there appear to travel downwards - an opening mouth. The vertical
   gate confines the effect to the lower half of the box, because a dog's
   upper jaw doesn't move; only the mandible drops. Without that gate the
   whole snout inflates and it reads as a balloon rather than a mouth. */
vec2 applyJaw(vec2 uv, float amount) {
  if (amount <= 0.0001) return uv;

  vec2 centre = u_mouthBox.xy + u_mouthBox.zw * 0.5;
  vec2 radius = u_mouthBox.zw * 0.85;
  vec2 d = (uv - centre) / max(radius, vec2(0.0001));

  float dist = length(d);
  if (dist > 1.0) return uv;

  float falloff = 1.0 - smoothstep(0.0, 1.0, dist);
  float gate = smoothstep(-0.25, 0.55, d.y);

  uv.y -= amount * u_mouthBox.w * falloff * gate;
  return uv;
}

/* Blink.
   Squash the sample space vertically toward the eye centre. At full closure
   the eye region collapses to its own midline, which reads as a shut lid
   without needing a painted eyelid asset. */
vec2 applyEye(vec2 uv, vec4 box, float amount) {
  if (amount <= 0.0001 || box.z <= 0.0) return uv;

  vec2 centre = box.xy + box.zw * 0.5;
  vec2 radius = box.zw * 1.15;
  vec2 d = (uv - centre) / max(radius, vec2(0.0001));

  if (dot(d, d) > 1.0) return uv;

  float falloff = 1.0 - smoothstep(0.0, 1.0, length(d));
  uv.y = mix(uv.y, centre.y, amount * falloff * 0.92);
  return uv;
}

/* ---------------------------------------------------------------- *
 * Procedural backgrounds
 * ---------------------------------------------------------------- */

vec3 backgroundColor(vec2 uv) {
  float pulse = 1.0 + u_bgReactive * u_energy * 0.18;

  if (u_bgMode == 2) {                          // sunset
    vec3 top = vec3(0.98, 0.45, 0.25) * pulse;
    vec3 mid = vec3(0.99, 0.72, 0.32);
    vec3 bot = vec3(0.35, 0.15, 0.36);
    vec3 c = uv.y < 0.5 ? mix(top, mid, uv.y * 2.0)
                        : mix(mid, bot, (uv.y - 0.5) * 2.0);
    float sun = 1.0 - smoothstep(0.0, 0.34, distance(uv, vec2(0.5, 0.42)));
    return c + sun * 0.30 * pulse;
  }

  if (u_bgMode == 3) {                          // studio
    float r = distance(uv, vec2(0.5, 0.4));
    vec3 c = mix(u_bgColor * 1.25, u_bgColor * 0.18, smoothstep(0.05, 0.85, r));
    return c * pulse;
  }

  if (u_bgMode == 4) {                          // park
    vec3 sky = mix(vec3(0.55, 0.80, 0.95), vec3(0.88, 0.95, 1.0), uv.y * 1.6);
    vec3 grass = mix(vec3(0.36, 0.63, 0.26), vec3(0.20, 0.42, 0.16), uv.y);
    float horizon = smoothstep(0.60, 0.66, uv.y);
    vec3 c = mix(sky, grass, horizon);
    // Cheap bokeh: a couple of octaves of noise, only above the horizon.
    float b = noise(uv * 7.0 + u_time * 0.05) * (1.0 - horizon);
    return (c + b * 0.10) * pulse;
  }

  if (u_bgMode == 5) {                          // neon
    vec2 p = uv * 2.0 - 1.0;
    p.x *= u_aspect;
    float a = atan(p.y, p.x);
    float r = length(p);
    float rings = sin(r * 14.0 - u_time * 1.4 + u_energy * 5.0) * 0.5 + 0.5;
    vec3 c1 = vec3(0.95, 0.25, 0.65);
    vec3 c2 = vec3(0.20, 0.55, 0.98);
    vec3 c = mix(c1, c2, sin(a * 2.0 + u_time * 0.4) * 0.5 + 0.5);
    return c * (0.28 + rings * 0.55) * pulse;
  }

  return u_bgColor * pulse;                     // solid
}

void main() {
  vec2 centre = vec2(0.5);

  /* --- Inverse camera ------------------------------------------- */
  vec2 p = toSquare(v_uv - centre);
  p = rotate(p, -u_tilt);
  p /= max(u_zoom, 0.0001);
  p = fromSquare(p) + centre - u_translate;

  vec2 texUV = p * u_texScale + u_texOffset;

  /* --- Background ----------------------------------------------- */
  vec2 bgUV = (p - u_bgShift) * u_texScale + u_texOffset;
  vec3 bg;

  if (u_bgMode == 0) {
    bg = texture(u_source, clamp(bgUV, 0.0, 1.0)).rgb;
  } else if (u_bgMode == 1) {
    bg = texture(u_blurred, clamp(bgUV, 0.0, 1.0)).rgb;
    // Darken slightly so the subject separates from its own blurred copy.
    bg *= 0.82;
  } else {
    bg = backgroundColor(v_uv - u_bgShift * 0.5);
  }

  /* --- No cutout: warp the whole photo and show it ---------------- */
  if (u_hasCutout < 0.5) {
    vec2 uv = texUV;
    uv = applyJaw(uv, u_jaw);
    uv = applyEye(uv, u_leftEye, u_blink);
    uv = applyEye(uv, u_rightEye, u_blink);
    vec4 src = texture(u_source, clamp(uv, 0.0, 1.0));
    outColor = vec4(src.rgb, 1.0);
    return;
  }

  /* --- Body transform, about the chest --------------------------- *
   * Rolling and breathing pivot at the chest rather than the image
   * centre: a dog flopping over rotates about its own body, and a
   * centre pivot makes the head swing through an obviously wrong arc. */
  vec2 bodyUV = texUV;
  vec2 pivot = u_chest;

  vec2 q = toSquare(bodyUV - pivot);
  q = rotate(q, -u_roll);
  q /= max(u_breath, 0.0001);
  bodyUV = fromSquare(q) + pivot;
  bodyUV.y -= u_hop;

  /* --- Facial deformations --------------------------------------- */
  bodyUV = applyJaw(bodyUV, u_jaw);
  bodyUV = applyEye(bodyUV, u_leftEye, u_blink);
  bodyUV = applyEye(bodyUV, u_rightEye, u_blink);

  /* --- Composite -------------------------------------------------- */
  vec4 dog = texture(u_cutout, clamp(bodyUV, 0.0, 1.0));

  // Kill any sample that wandered outside the texture, or the edge clamp
  // smears the dog's border pixels across the background.
  if (bodyUV.x < 0.0 || bodyUV.x > 1.0 || bodyUV.y < 0.0 || bodyUV.y > 1.0) {
    dog.a = 0.0;
  }

  // Contact shadow: a soft dark pool under the subject, offset opposite the
  // hop. Costs almost nothing and does most of the work of making the dog sit
  // in the scene rather than float in front of it.
  float shadow = texture(u_cutout, clamp(bodyUV + vec2(0.012, -0.028), 0.0, 1.0)).a;
  bg = mix(bg, bg * 0.55, shadow * 0.45);

  vec3 composited = mix(bg, dog.rgb, dog.a);

  /* --- Vignette --------------------------------------------------- */
  float vig = 1.0 - smoothstep(0.55, 1.15, distance(v_uv, centre) * 1.35);
  composited *= 0.72 + vig * 0.28;

  outColor = vec4(composited, 1.0);
}`;

/* ------------------------------------------------------------------ *
 * GL plumbing
 * ------------------------------------------------------------------ */

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Failed to create shader");
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`Shader compile failed: ${log}`);
  }
  return shader;
}

function createTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error("Failed to create texture");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

function upload(gl: WebGL2RenderingContext, tex: WebGLTexture, source: TexImageSource): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 0);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
}

/** 1x1 transparent stand-in, so samplers always have something bound. */
function uploadBlank(gl: WebGL2RenderingContext, tex: WebGLTexture): void {
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
}

const BG_MODES: Record<string, number> = {
  original: 0,
  blur: 1,
  sunset: 2,
  studio: 3,
  park: 4,
  neon: 5,
  solid: 6,
};

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  if (h.length !== 6) return [1, 1, 1];
  return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255];
}

/**
 * Pre-blur the photo once into a texture-ready canvas.
 *
 * A separable Gaussian in GLSL would need two extra passes and a framebuffer
 * each; the 2D context's `filter` property hands us a hardware-accelerated
 * blur for three lines, and since the background blur never changes during
 * playback there's no reason to recompute it per frame.
 */
function makeBlurred(source: ImageBitmap, blurPx: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = source.width;
  canvas.height = source.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    // Scale the radius to the image so a 4000px photo doesn't get a blur that
    // reads as barely-there next to the same setting on a 600px one.
    const scaled = (blurPx * source.width) / 1080;
    ctx.filter = `blur(${Math.max(1, scaled)}px)`;
    ctx.drawImage(source, 0, 0);
    ctx.filter = "none";
  }
  return canvas;
}

/* ------------------------------------------------------------------ *
 * Renderer
 * ------------------------------------------------------------------ */

export interface RendererInputs {
  layers: LayerSet;
  anchors: DogAnchors;
  words: WordTimestamp[];
  envelope: AudioEnvelope | null;
  rigConfig: RigConfig;
  captions: CaptionConfig;
  background: BackgroundConfig;
  durationSec: number;
  width: number;
  height: number;
}

export class FrameRenderer {
  private gl: WebGL2RenderingContext;
  private glCanvas: HTMLCanvasElement | OffscreenCanvas;
  private program: WebGLProgram;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};

  private texSource: WebGLTexture;
  private texCutout: WebGLTexture;
  private texBlurred: WebGLTexture;

  private tables: RigTables;
  private inputs: RendererInputs;

  /** Cover-fit mapping from canvas UV into texture UV. */
  private texScale: [number, number] = [1, 1];
  private texOffset: [number, number] = [0, 0];

  constructor(inputs: RendererInputs) {
    this.inputs = inputs;

    const canvas = document.createElement("canvas");
    canvas.width = inputs.width;
    canvas.height = inputs.height;
    this.glCanvas = canvas;

    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: true,
      // Required: without this the drawing buffer may be cleared before the
      // exporter gets a chance to read it back.
      preserveDrawingBuffer: true,
      premultipliedAlpha: false,
    });
    if (!gl) throw new Error("WebGL2 is not available in this browser.");
    this.gl = gl;

    const vert = compile(gl, gl.VERTEX_SHADER, VERT);
    const frag = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram();
    if (!program) throw new Error("Failed to create program");
    gl.attachShader(program, vert);
    gl.attachShader(program, frag);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(`Program link failed: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    gl.useProgram(program);

    // Full-screen quad as two triangles.
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a_pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    for (const name of [
      "u_source",
      "u_cutout",
      "u_blurred",
      "u_hasCutout",
      "u_aspect",
      "u_time",
      "u_texScale",
      "u_texOffset",
      "u_zoom",
      "u_tilt",
      "u_roll",
      "u_breath",
      "u_hop",
      "u_jaw",
      "u_blink",
      "u_energy",
      "u_translate",
      "u_bgShift",
      "u_mouthBox",
      "u_leftEye",
      "u_rightEye",
      "u_chest",
      "u_bgMode",
      "u_bgColor",
      "u_bgReactive",
    ]) {
      this.uniforms[name] = gl.getUniformLocation(program, name);
    }

    this.texSource = createTexture(gl);
    this.texCutout = createTexture(gl);
    this.texBlurred = createTexture(gl);

    this.tables = buildRigTables(inputs.rigConfig, inputs.envelope, inputs.durationSec);

    this.uploadTextures();
    this.computeFit();
  }

  private uploadTextures(): void {
    const { gl } = this;
    const { layers, background } = this.inputs;

    upload(gl, this.texSource, layers.source);

    if (layers.cutout) {
      upload(gl, this.texCutout, layers.cutout);
    } else {
      uploadBlank(gl, this.texCutout);
    }

    if (background.id === "blur") {
      upload(gl, this.texBlurred, makeBlurred(layers.source, background.blurPx));
    } else {
      uploadBlank(gl, this.texBlurred);
    }
  }

  /**
   * Cover-fit: scale the photo so it fills the 9:16 frame with no letterboxing,
   * cropping the long axis. Computed once because neither the photo nor the
   * output size changes mid-clip.
   */
  private computeFit(): void {
    const { layers, width, height } = this.inputs;
    const imageAspect = layers.width / layers.height;
    const canvasAspect = width / height;

    if (imageAspect > canvasAspect) {
      // Photo is wider: crop horizontally.
      const visible = canvasAspect / imageAspect;
      this.texScale = [visible, 1];
      this.texOffset = [(1 - visible) / 2, 0];
    } else {
      const visible = imageAspect / canvasAspect;
      this.texScale = [1, visible];
      this.texOffset = [0, (1 - visible) / 2];
    }
  }

  /** Swap configuration without rebuilding GL state. */
  update(partial: Partial<RendererInputs>): void {
    const needsTextures = partial.layers !== undefined || partial.background !== undefined;
    const needsTables =
      partial.rigConfig !== undefined || partial.envelope !== undefined || partial.durationSec !== undefined;

    this.inputs = { ...this.inputs, ...partial };

    if (needsTextures) this.uploadTextures();
    if (partial.layers) this.computeFit();
    if (needsTables) {
      this.tables = buildRigTables(this.inputs.rigConfig, this.inputs.envelope, this.inputs.durationSec);
    }
  }

  /** The rig pose at `t`. Exposed so the UI can show live debug readouts. */
  poseAt(t: number): RigState {
    return evaluateRig(t, this.inputs.rigConfig, this.inputs.envelope, this.tables);
  }

  /**
   * Render the GL layers for time `t`. Pure with respect to `t`.
   */
  renderGL(t: number): void {
    const { gl, uniforms: u, inputs } = this;
    const state = this.poseAt(t);
    const { anchors, layers, background, width, height } = inputs;

    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texSource);
    gl.uniform1i(u.u_source, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texCutout);
    gl.uniform1i(u.u_cutout, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texBlurred);
    gl.uniform1i(u.u_blurred, 2);

    gl.uniform1f(u.u_hasCutout, layers.cutout ? 1 : 0);
    gl.uniform1f(u.u_aspect, width / height);
    gl.uniform1f(u.u_time, t);

    gl.uniform2fv(u.u_texScale, this.texScale);
    gl.uniform2fv(u.u_texOffset, this.texOffset);

    gl.uniform1f(u.u_zoom, state.zoom);
    gl.uniform1f(u.u_tilt, state.tilt + state.nod * 0.35);
    gl.uniform1f(u.u_roll, state.roll);
    gl.uniform1f(u.u_breath, state.breath);
    gl.uniform1f(u.u_hop, state.hop + state.nod * 0.02);
    gl.uniform1f(u.u_jaw, state.jaw);
    gl.uniform1f(u.u_blink, state.blink);
    gl.uniform1f(u.u_energy, state.energy);
    gl.uniform2f(u.u_translate, state.swayX + state.shakeX, state.swayY + state.shakeY);
    gl.uniform2f(u.u_bgShift, state.bgX, state.bgY);

    gl.uniform4f(u.u_mouthBox, anchors.mouth.x, anchors.mouth.y, anchors.mouth.w, anchors.mouth.h);

    const le = anchors.leftEye;
    const re = anchors.rightEye;
    gl.uniform4f(u.u_leftEye, le?.x ?? 0, le?.y ?? 0, le?.w ?? 0, le?.h ?? 0);
    gl.uniform4f(u.u_rightEye, re?.x ?? 0, re?.y ?? 0, re?.w ?? 0, re?.h ?? 0);
    gl.uniform2f(u.u_chest, anchors.chest.x, anchors.chest.y);

    gl.uniform1i(u.u_bgMode, BG_MODES[background.id] ?? 1);
    gl.uniform3fv(u.u_bgColor, hexToRgb(background.color));
    gl.uniform1f(u.u_bgReactive, background.reactive ? 1 : 0);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /**
   * Render the complete frame - GL layers plus captions - into `ctx`.
   *
   * This is the single entry point shared by preview and export. If it is ever
   * given a reason to consult wall-clock time, the two will drift apart and
   * the preview stops being a promise about the output.
   */
  renderFrame(ctx: CanvasRenderingContext2D, t: number): void {
    const { width, height, words, captions } = this.inputs;

    this.renderGL(t);
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.glCanvas as CanvasImageSource, 0, 0, width, height);
    drawCaptions(ctx, words, t, captions, width, height);
  }

  dispose(): void {
    const { gl } = this;
    gl.deleteTexture(this.texSource);
    gl.deleteTexture(this.texCutout);
    gl.deleteTexture(this.texBlurred);
    gl.deleteProgram(this.program);
    // Frees the backing drawing buffer immediately rather than waiting for GC,
    // which matters because browsers cap the number of live WebGL contexts.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}
