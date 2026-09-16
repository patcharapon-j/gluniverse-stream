import { MODULE_ID } from "../constants.js";
import { CRACK_COLORS, FX_FRAG_ROLL_CARD_BREAK, ROLL_CARD_CRACK_SHAPE } from "./crack-glsl.js";

/** Render the field larger than the card and let the blit downsample: MSAA cannot smooth shader edges. */
const SUPERSAMPLE = 1.25;
/** The cracks pulse slowly, so 30fps looks the same as 60 at half the GPU and blit cost. */
const FRAME_MS = 1000 / 30;

/**
 * Draws the roll card crack effect.
 *
 * Same layout as the suite's CardFXManager: one offscreen PIXI renderer with one filter, created on
 * first use. Every frame it renders each cracked card at its own size into the renderer's top-left
 * corner and copies that region into the card's own 2D canvas. The renderer only grows, so cards of
 * different sizes never force a render-target reallocation. It rides requestAnimationFrame, so the
 * browser pauses it with the tab, and it stops when no card is cracked.
 */
class CrackRenderer {
  constructor() {
    this.renderer = null;
    this.sprite = null;
    this.filter = null;
    this.initTried = false;
    this.supported = false;
    this.entries = new Set();
    this.ticking = false;
    this.lastDraw = 0;
    this.tick = this.tick.bind(this);
  }

  /** True when the effect can draw. The first call creates the renderer. */
  get ok() {
    return this.ensureRenderer();
  }

  ensureRenderer() {
    if (this.initTried) return this.supported;
    this.initTried = true;
    try {
      const PIXI = globalThis.PIXI;
      if (!PIXI?.Renderer || !PIXI?.Filter || !PIXI?.Sprite) return false;
      this.renderer = new PIXI.Renderer({ width: 512, height: 96, backgroundAlpha: 0, antialias: true });
      this.sprite = new PIXI.Sprite(PIXI.Texture.WHITE);
      this.filter = new PIXI.Filter(undefined, FX_FRAG_ROLL_CARD_BREAK, {
        uTime: 0,
        uSeed: 0,
        uAspect: 1,
        uThick: ROLL_CARD_CRACK_SHAPE.thick,
        uTexel: 0,
        uDense: ROLL_CARD_CRACK_SHAPE.dense,
        uReach: ROLL_CARD_CRACK_SHAPE.reach,
        uImpact: [0.84, 0.5],
        uBreakAmber: [...CRACK_COLORS.gold.base],
        uBreakHot: [...CRACK_COLORS.gold.hot]
      });
      this.filter.padding = 0;
      // Compile the program now, not on the frame a crit lands.
      try {
        this.sprite.width = 4;
        this.sprite.height = 4;
        this.sprite.filters = [this.filter];
        this.renderer.render(this.sprite);
      } catch (_error) {
        // It compiles on demand instead.
      }
      this.supported = true;
    } catch (error) {
      console.warn(`${MODULE_ID} | Roll card crack effect unavailable, using the glow fallback`, error);
      this.renderer = null;
      this.supported = false;
    }
    return this.supported;
  }

  /**
   * Starts cracking a canvas. Returns a handle for `remove` and `setColor`, or null when WebGL is
   * unavailable. The seed and impact default to random so no two cards crack alike; pass them to make
   * a second canvas (the damage row) carry the same fracture.
   */
  add(canvas, { color = "gold", seed, impact, dense, reach, thick } = {}) {
    if (!canvas || !this.ensureRenderer()) return null;
    const handle = {
      canvas,
      ctx: canvas.getContext("2d"),
      color: CRACK_COLORS[color] ? color : "gold",
      seed: seed ?? Math.random() * 100,
      impact: impact ?? [0.8 + Math.random() * 0.08, 0.3 + Math.random() * 0.4],
      dense: dense ?? ROLL_CARD_CRACK_SHAPE.dense,
      reach: reach ?? ROLL_CARD_CRACK_SHAPE.reach,
      thick: thick ?? ROLL_CARD_CRACK_SHAPE.thick,
      t0: performance.now()
    };
    this.entries.add(handle);
    this.start();
    return handle;
  }

  remove(handle) {
    if (!handle) return;
    this.entries.delete(handle);
    try {
      handle.ctx?.clearRect(0, 0, handle.canvas.width, handle.canvas.height);
    } catch (_error) {
      // The canvas may already be gone.
    }
  }

  /** Recolours a running crack in place, keeping its shape and clock. */
  setColor(handle, color) {
    if (handle && CRACK_COLORS[color]) handle.color = color;
  }

  start() {
    if (this.ticking || !this.entries.size) return;
    this.ticking = true;
    requestAnimationFrame(this.tick);
  }

  tick() {
    if (!this.entries.size) {
      this.ticking = false;
      return;
    }
    requestAnimationFrame(this.tick);
    const now = performance.now();
    if (now - this.lastDraw < FRAME_MS) return;
    this.lastDraw = now;

    const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
    for (const entry of this.entries) {
      const canvas = entry.canvas;
      if (!canvas.isConnected) {
        this.entries.delete(entry);
        continue;
      }
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      if (!cw || !ch || !entry.ctx) continue;
      const pw = Math.max(1, Math.round(cw * dpr));
      const ph = Math.max(1, Math.round(ch * dpr));
      if (canvas.width !== pw || canvas.height !== ph) {
        // Resizing resets the 2D context, so the smoothing quality has to be set again.
        canvas.width = pw;
        canvas.height = ph;
        entry.ctx.imageSmoothingEnabled = true;
        entry.ctx.imageSmoothingQuality = "high";
      }
      const rw = Math.max(1, Math.round(pw * SUPERSAMPLE));
      const rh = Math.max(1, Math.round(ph * SUPERSAMPLE));
      try {
        if (this.renderer.width < rw || this.renderer.height < rh) {
          this.renderer.resize(Math.max(this.renderer.width, rw), Math.max(this.renderer.height, rh));
        }
        const colors = CRACK_COLORS[entry.color];
        const u = this.filter.uniforms;
        u.uTime = (now - entry.t0) / 1000;
        u.uSeed = entry.seed;
        u.uAspect = rw / rh;
        u.uTexel = 1 / rh;
        u.uThick = entry.thick;
        u.uDense = entry.dense;
        u.uReach = entry.reach;
        u.uImpact = entry.impact;
        u.uBreakAmber = colors.base;
        u.uBreakHot = colors.hot;
        this.sprite.width = rw;
        this.sprite.height = rh;
        this.sprite.filters = [this.filter];
        this.renderer.render(this.sprite);
        entry.ctx.clearRect(0, 0, pw, ph);
        entry.ctx.drawImage(this.renderer.view, 0, 0, rw, rh, 0, 0, pw, ph);
      } catch (_error) {
        // Leave this canvas transparent; the card's glow still marks the crit.
      }
    }
  }

  destroy() {
    this.entries.clear();
    this.ticking = false;
    try {
      this.renderer?.destroy();
    } catch (_error) {
      // Already gone.
    }
    this.renderer = null;
    this.supported = false;
    this.initTried = false;
  }
}

/** The one crack renderer shared by every roll card. */
export const crackRenderer = new CrackRenderer();
