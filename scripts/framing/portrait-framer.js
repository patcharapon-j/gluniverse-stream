import { MODULE_ID } from "../constants.js";
import { ART_ASPECT, cropForFace, pickFace, tileWindows, toFocus } from "./focus-math.js";

const VENDOR = `modules/${MODULE_ID}/scripts/vendor`;
const CACHE_KEY = `${MODULE_ID}.portraitFocus.v1`;
const CACHE_LIMIT = 400;
/** Images are analysed at this size: plenty for a face, and it keeps each pass near 200 ms. */
const ANALYSIS_PX = 512;
const TILE_PX = 384;

/**
 * Finds where to frame character art on the stream client.
 *
 * Each image is analysed once, in the background, one at a time: a face found by MediaPipe's
 * face detector (run on zoomed windows so small faces in full-body art are seen), otherwise
 * smartcrop's pick. Results are cached in memory and in this browser's storage, keyed by image path.
 * `null` means "analysed, nothing better than the default crop".
 */
export class PortraitFramer {
  constructor() {
    /** src -> {focus, method} | null */
    this.cache = loadCache();
    /** src -> Promise */
    this.inflight = new Map();
    /** Sources whose result is a session-only fallback, never written to storage. */
    this.unsaved = new Set();
    this.queue = [];
    this.draining = false;
    this.tools = null;
  }

  /** The cached framing: a focus, null (default crop), or undefined when the image is not analysed yet. */
  peek(src) {
    if (!src) return null;
    if (!this.cache.has(src)) return undefined;
    return this.cache.get(src)?.focus ?? null;
  }

  /** Resolves with the image's focus (or null), analysing it first if needed. */
  request(src) {
    if (!src) return Promise.resolve(null);
    if (this.cache.has(src)) return Promise.resolve(this.peek(src));
    if (this.inflight.has(src)) return this.inflight.get(src);
    const promise = new Promise(resolve => this.queue.push({ src, resolve }));
    this.inflight.set(src, promise);
    this.drain();
    return promise;
  }

  /** Queues images so their first card is already framed. */
  prescan(sources) {
    for (const src of new Set(sources)) if (src) this.request(src);
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length) {
        const { src, resolve } = this.queue.shift();
        let result = null;
        let persist = true;
        try {
          result = await this.analyse(src);
        } catch (error) {
          // A load or CORS failure may not last; keep the default crop for this session only.
          persist = false;
          console.warn(`${MODULE_ID} | Could not frame ${src}; using the default crop`, error);
        }
        this.remember(src, result, { persist });
        this.inflight.delete(src);
        resolve(result?.focus ?? null);
        // Give the stream a breath between images.
        await new Promise(r => setTimeout(r, 60));
      }
    } finally {
      this.draining = false;
    }
  }

  async analyse(src) {
    const image = await loadImage(src);
    const scale = Math.min(1, ANALYSIS_PX / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    // Throws on cross-origin art without CORS; the caller falls back to the default crop.
    ctx.getImageData(0, 0, 1, 1);

    const tools = await this.loadTools();
    if (tools?.detector) {
      const face = pickFace(await detectFaces(tools.detector, canvas), width, height);
      if (face) return { focus: toFocus(cropForFace(face.box, width, height, ART_ASPECT), width), method: "face" };
    }
    if (tools?.smartcrop) {
      const { topCrop } = await tools.smartcrop.crop(canvas, { width: 186, height: 100, minScale: 0.5 });
      if (topCrop) return { focus: toFocus(topCrop, width), method: "smart" };
    }
    return null;
  }

  /** MediaPipe and smartcrop, loaded on first use. Either may be missing; framing degrades, never breaks. */
  async loadTools() {
    if (this.tools) return this.tools;
    const tools = { detector: null, smartcrop: null };
    try {
      const vision = await import(route(`${VENDOR}/mediapipe/vision_bundle.mjs`));
      const fileset = await vision.FilesetResolver.forVisionTasks(route(`${VENDOR}/mediapipe/wasm`));
      tools.detector = await vision.FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: route(`${VENDOR}/mediapipe/blaze_face_short_range.tflite`), delegate: "CPU" },
        runningMode: "IMAGE",
        minDetectionConfidence: 0.3
      });
    } catch (error) {
      console.warn(`${MODULE_ID} | Face detection unavailable; portraits use content-aware or default framing`, error);
    }
    try {
      tools.smartcrop = await loadSmartcrop();
    } catch (error) {
      console.warn(`${MODULE_ID} | smartcrop unavailable`, error);
    }
    this.tools = tools;
    return tools;
  }

  remember(src, result, { persist = true } = {}) {
    this.cache.delete(src);
    this.cache.set(src, result);
    while (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
    if (!persist) {
      this.unsaved.add(src);
      return;
    }
    this.unsaved.delete(src);
    try {
      const saved = [...this.cache].filter(([key]) => !this.unsaved.has(key));
      localStorage.setItem(CACHE_KEY, JSON.stringify(saved));
    } catch {
      // Storage full or blocked: the in-memory cache still serves this session.
    }
  }

  /** Forgets every cached framing, e.g. after art is replaced under the same path. */
  forgetAll() {
    this.cache.clear();
    try {
      localStorage.removeItem(CACHE_KEY);
    } catch {
      // Nothing stored.
    }
  }
}

/**
 * Whole image, then every zoomed window, mapped back to image pixels. It yields to the page between
 * windows: each detection is a few milliseconds of main-thread work, and the stream must not hitch.
 */
async function detectFaces(detector, canvas) {
  const found = [];
  const collect = (detections, sx, sy, k) => {
    for (const d of detections) {
      const b = d.boundingBox;
      found.push({
        score: d.categories?.[0]?.score ?? 0,
        box: { x: sx + b.originX / k, y: sy + b.originY / k, width: b.width / k, height: b.height / k }
      });
    }
  };
  collect(detector.detect(canvas).detections, 0, 0, 1);
  const tile = document.createElement("canvas");
  tile.width = tile.height = TILE_PX;
  const ctx = tile.getContext("2d");
  for (const w of tileWindows(canvas.width, canvas.height)) {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    ctx.drawImage(canvas, w.x, w.y, w.size, w.size, 0, 0, TILE_PX, TILE_PX);
    collect(detector.detect(tile).detections, w.x, w.y, TILE_PX / w.size);
    await yieldToPage();
  }
  return found;
}

function yieldToPage() {
  if (globalThis.scheduler?.yield) return globalThis.scheduler.yield();
  return new Promise(resolve => setTimeout(resolve, 0));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = new URL(src, window.location.href);
    if (url.origin !== window.location.origin) image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Image failed to load: ${src}`));
    image.src = url.href;
  });
}

let smartcropPromise = null;
function loadSmartcrop() {
  if (globalThis.smartcrop) return Promise.resolve(globalThis.smartcrop);
  smartcropPromise ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = route(`${VENDOR}/smartcrop.js`);
    script.onload = () => (globalThis.smartcrop ? resolve(globalThis.smartcrop) : reject(new Error("smartcrop did not load")));
    script.onerror = () => reject(new Error("smartcrop did not load"));
    document.head.append(script);
  });
  return smartcropPromise;
}

function route(path) {
  return foundry.utils.getRoute(path);
}

function loadCache() {
  try {
    const entries = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "[]");
    return new Map(Array.isArray(entries) ? entries : []);
  } catch {
    return new Map();
  }
}

/** The one framer for this client. */
export const portraitFramer = new PortraitFramer();
