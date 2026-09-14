import { TARGET_LINE_MOTION } from "../constants.js";
import { animate, remove } from "../motion/engine.js";
import { createPath, lineGeometry, pointAt, ringRadius } from "./target-geometry.js";

/**
 * The etched rim under every body and reticle. A fixed near-black rather than a tint, because a dark edge is
 * what separates a line from bright map art. With white it is the only colour this file does not take from the
 * relationship colour setting.
 */
const INK = 0x080a0e;
const WHITE = 0xffffff;
/** The reticle's alpha while a hand-off moves the origin and keeps the target. */
const RETICLE_HANDOFF_ALPHA = 0.45;
/** The reticle pops in from this multiple of its radius, and a collapsing one grows out to it. */
const RETICLE_POP_SCALE = 1.6;
/** During the pop, the reticle's alpha reaches 1 this many times sooner than its scale settles. */
const RETICLE_POP_ALPHA_RATE = 1.6;
const QUADRANT_SPAN = Math.PI * 0.22;
const HEAD_LENGTH_SQUARES = 0.26;
const HEAD_HALF_WIDTH_SQUARES = 0.11;
/** The head fades in over the last stretch of the reach, so it lands with the line. */
const HEAD_FADE_FROM = 0.82;
const SWEEP_LENGTH_SQUARES = 0.6;
/** The sweep's white hairline covers its leading part only. */
const SWEEP_LEAD_FROM = 0.55;
const TAU = Math.PI * 2;

/** One lineStyle options object reused for every stroke; PIXI copies what it needs out of it. */
const LINE = { width: 1, color: WHITE, alpha: 1, cap: "round", join: "round", native: false };

/**
 * One targeting line from a source token to a target token, cut as Etched Glass (the "Etched Bow"): an arc with a
 * dark etched rim, a band and core tinted with the relationship colour and a one-device-pixel bright hairline,
 * under one blurred halo. A filled wedge lands on a hairline reticle whose four quadrant marks turn once every
 * six seconds, and a single light sweep runs down the body while it holds.
 *
 * anime.js drives every animated value on `state`; `render` turns that state and the tokens' current (animated)
 * positions into PIXI geometry once per canvas frame. A line targeting its own source draws only the reticle.
 *
 * Graphics: `halo` sits in the controller's shared blurred ADD container, `core` draws normally (the etched rim
 * would vanish under ADD), and `glint` adds the sweep's light on top.
 */
export class TargetLine {
  state = { reach: 0, body: 1, ringAlpha: 0, ringScale: 1, sweep: 0, spin: 0, pulse: 0.5, sink: 0, rise: 0 };
  shown = false;
  leaving = false;
  destroyed = false;
  /** Set while a hand-off retracts the body into the old source; the next `show()` relaunches from here. */
  nextSourceId = null;
  loops = [];
  path = createPath();
  #point = { x: 0, y: 0, tx: 1, ty: 0 };
  #geometry = { from: null, to: null, sourceSize: 0, targetSize: 0, gridSize: 100 };

  constructor({ sourceId, targetId, halo, core, glint, style, calm, onGone }) {
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.calm = calm;
    this.onGone = onGone;
    this.haloGraphics = halo.addChild(new PIXI.Graphics());
    this.coreGraphics = core.addChild(new PIXI.Graphics());
    this.glintGraphics = (glint ?? core).addChild(new PIXI.Graphics());
    this.glintGraphics.blendMode = PIXI.BLEND_MODES.ADD;
    this.setStyle(style);
    if (!calm) this.#startLoops();
  }

  get isSelfTarget() {
    return this.sourceId === this.targetId;
  }

  setStyle(style) {
    this.style = style;
    this.bright = mixColor(Number(style?.color) || 0, WHITE, 0.65);
  }

  /**
   * Launch the line; turn a retracting line around from wherever it has got to; or, after `retarget()`, move it
   * to its new source and relaunch from there with the kept reticle brightening back up.
   */
  show() {
    if (this.destroyed) return;
    const first = !this.shown;
    const relaunch = this.nextSourceId != null;
    if (!first && !this.leaving && !relaunch) return;
    const reversing = this.leaving;
    this.shown = true;
    this.leaving = false;
    if (relaunch) {
      this.sourceId = this.nextSourceId;
      this.nextSourceId = null;
    }
    this.#resumeLoops();
    const motion = TARGET_LINE_MOTION;
    const state = this.state;

    if (this.calm) {
      state.reach = 1;
      state.ringScale = 1;
      if (first) {
        state.body = 0;
        state.ringAlpha = 0;
      }
      animate(state, { body: 1, ringAlpha: 1, duration: motion.calmFadeInMs, ease: "outQuad" });
      return;
    }

    state.body = 1;
    const reachMs = this.isSelfTarget ? 1 : Math.max(1, motion.launchMs * (1 - clamp01(state.reach)));
    animate(state, { reach: 1, duration: reachMs, ease: "outCubic" });
    if (first) {
      state.ringAlpha = 0;
      state.ringScale = RETICLE_POP_SCALE;
      const delay = this.isSelfTarget ? 0 : motion.reticlePopDelayMs;
      animate(state, { ringScale: 1, duration: motion.reticlePopMs, delay, ease: "outBack(2.2)" });
      animate(state, {
        ringAlpha: 1,
        duration: motion.reticlePopMs / RETICLE_POP_ALPHA_RATE,
        delay,
        ease: "linear"
      });
    } else if (relaunch) {
      animate(state, { ringAlpha: 1, ringScale: 1, duration: motion.launchMs, ease: "outCubic" });
      if (!this.isSelfTarget) {
        animate(state, { rise: [0, 1], duration: motion.originRiseMs, ease: "linear" });
      }
    } else if (reversing) {
      animate(state, { ringAlpha: 1, ringScale: 1, duration: motion.reticleCollapseMs, ease: "outCubic" });
    }
  }

  /** Retract into the source and collapse the reticle (or fade, in calm mode), then remove the line. */
  hide() {
    if (this.destroyed || this.leaving) return;
    this.leaving = true;
    this.nextSourceId = null;
    const finish = () => {
      if (this.leaving) this.destroy();
    };
    const motion = TARGET_LINE_MOTION;
    const state = this.state;
    if (this.calm) {
      animate(state, { body: 0, ringAlpha: 0, duration: motion.calmFadeOutMs, ease: "inQuad", onComplete: finish });
      return;
    }
    animate(state, {
      ringAlpha: 0,
      ringScale: RETICLE_POP_SCALE,
      duration: motion.reticleCollapseMs,
      ease: "inCubic"
    });
    animate(state, {
      reach: 0,
      duration: Math.max(motion.reticleCollapseMs, motion.retractMs * clamp01(state.reach)),
      ease: "inCubic",
      onComplete: finish
    });
  }

  /**
   * Hand the line to another source without losing its target: the body retracts into the current source while
   * a hairline ring sinks into it, and the reticle stays up at 45% with its loops frozen. The line then waits;
   * the controller calls `show()` after the beat to relaunch it from `sourceId`, or `hide()` if the target went.
   */
  retarget(sourceId) {
    if (this.destroyed || this.leaving || !this.shown) return;
    if (this.nextSourceId === sourceId) return;
    const retracting = this.nextSourceId != null;
    this.nextSourceId = sourceId;
    if (retracting) return;
    this.#freezeLoops();
    const motion = TARGET_LINE_MOTION;
    const state = this.state;
    if (this.calm) {
      animate(state, { body: 0, duration: motion.calmFadeOutMs, ease: "inQuad" });
      animate(state, {
        ringAlpha: RETICLE_HANDOFF_ALPHA,
        ringScale: 1,
        duration: motion.calmFadeOutMs,
        ease: "inQuad"
      });
      return;
    }
    animate(state, { reach: 0, duration: Math.max(1, motion.retractMs * clamp01(state.reach)), ease: "inCubic" });
    animate(state, { ringAlpha: RETICLE_HANDOFF_ALPHA, ringScale: 1, duration: motion.retractMs, ease: "inCubic" });
    if (!this.isSelfTarget) {
      animate(state, {
        sink: [0, 1],
        duration: motion.originSinkMs,
        delay: Math.max(0, motion.retractMs - motion.originSinkMs),
        ease: "linear"
      });
    }
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const loop of this.loops) loop?.cancel?.();
    this.loops = [];
    remove(this.state);
    if (!this.haloGraphics.destroyed) this.haloGraphics.destroy();
    if (!this.coreGraphics.destroyed) this.coreGraphics.destroy();
    if (!this.glintGraphics.destroyed) this.glintGraphics.destroy();
    this.onGone?.(this);
  }

  render({ source, target, scale, gridSize, resolution = 1 }) {
    const halo = this.haloGraphics;
    const core = this.coreGraphics;
    const glint = this.glintGraphics;
    halo.clear();
    core.clear();
    glint.clear();
    if (this.destroyed || !source?.document || !target?.document) return;

    const state = this.state;
    const color = Number(this.style?.color) || 0;
    const bright = this.bright;
    const zoom = Math.max(0.05, Number(scale) || 1);
    // Soft widths are authored in screen pixels and only partly follow the zoom, so the line stays legible when
    // the camera pulls back and does not turn into a rope when it pushes in. A hairline is one device pixel.
    const u = Math.max(0.5, Number(this.style?.intensity) || 1) / Math.pow(zoom, 0.65);
    const hl = 1 / (zoom * Math.max(0.25, Number(resolution) || 1));
    const pulse = this.calm ? 0.5 : clamp01(state.pulse);
    const body = clamp01(state.body);
    const reach = clamp01(state.reach);
    const from = source.center;
    const to = target.center;
    const targetSize = Math.max(target.w, target.h);
    const point = this.#point;

    if (!this.isSelfTarget && reach > 0.001 && body > 0.001) {
      const input = this.#geometry;
      input.from = from;
      input.to = to;
      input.sourceSize = Math.max(source.w, source.h);
      input.targetSize = targetSize;
      input.gridSize = gridSize;
      const path = lineGeometry(input, this.path);
      const end = path.length * reach;

      strokePath(halo, path, 0, end, 14 * u, color, (0.16 + (0.08 * pulse)) * body, point);
      strokePath(core, path, 0, end, (5 * u) + (2 * hl), INK, 0.5 * body, point);
      strokePath(core, path, 0, end, 5 * u, color, 0.3 * body, point);
      strokePath(core, path, 0, end, 2 * u, color, 0.85 * body, point);
      strokePath(core, path, 0, end, hl, bright, 0.95 * body, point);

      pointAt(path, 0, point);
      strokeCircle(core, point.x, point.y, 3 * u, 2 * hl, INK, 0.5 * body);
      fillCircle(core, point.x, point.y, 2.4 * u, bright, 0.95 * body);

      if (this.#holding(reach)) {
        const length = SWEEP_LENGTH_SQUARES * gridSize;
        const head = (clamp01(state.sweep) * (path.length + length)) - length;
        const stop = Math.min(path.length, head + length);
        strokePath(glint, path, Math.max(0, head), stop, 3 * u, bright, 0.35 * body, point);
        strokePath(glint, path, Math.max(0, head + (length * SWEEP_LEAD_FROM)), stop, 2 * hl, WHITE, 0.6 * body, point);
      }

      pointAt(path, end, point);
      const headAlpha = clamp01((reach - HEAD_FADE_FROM) / (1 - HEAD_FADE_FROM)) * body;
      if (headAlpha > 0.001) {
        drawHead(core, point, HEAD_LENGTH_SQUARES * gridSize, HEAD_HALF_WIDTH_SQUARES * gridSize, hl, color, bright, headAlpha);
      }
      if (!this.calm && reach < 0.98) {
        fillCircle(halo, point.x, point.y, 9 * u, color, 0.7 * body);
        fillCircle(core, point.x, point.y, 3 * u, bright, body);
      }
    }

    const ringAlpha = clamp01(state.ringAlpha);
    if (ringAlpha > 0.001) {
      const radius = ringRadius(targetSize) * Math.max(0, Number(state.ringScale) || 0);
      const spin = this.calm ? 0 : Number(state.spin) || 0;
      strokeCircle(halo, to.x, to.y, radius, 8 * u, color, (0.22 + (0.1 * pulse)) * ringAlpha);
      strokeCircle(core, to.x, to.y, radius, 3 * hl, INK, 0.45 * ringAlpha);
      strokeCircle(core, to.x, to.y, radius, hl, color, 0.7 * ringAlpha);
      for (let i = 0; i < 4; i++) {
        const start = spin + (i * Math.PI / 2) - (QUADRANT_SPAN / 2);
        strokeArc(core, to.x, to.y, radius, start, start + QUADRANT_SPAN, 3 * u, color, 0.95 * ringAlpha);
        strokeArc(core, to.x, to.y, radius, start, start + QUADRANT_SPAN, hl, bright, 0.95 * ringAlpha);
      }
    }

    // Hand-off origin cue: the same hairline ring sinking into the old source, then rising out of the new one.
    if (!this.calm && !this.isSelfTarget) {
      const sourceRadius = Math.max(source.w, source.h) / 2;
      const sink = Number(state.sink) || 0;
      if (sink > 0 && sink < 1) {
        const radius = sourceRadius * lerp(1.45, 0.9, sink * sink * sink);
        strokeCircle(core, from.x, from.y, radius, hl, bright, 0.9 * (1 - (0.6 * sink)));
      }
      const rise = Number(state.rise) || 0;
      if (rise > 0 && rise < 1) {
        const radius = sourceRadius * lerp(0.9, 1.5, 1 - Math.pow(1 - rise, 3));
        strokeCircle(core, from.x, from.y, radius, hl, bright, 0.9 * (1 - rise));
      }
    }
  }

  /** The sweep only runs down a body that is fully drawn and staying. */
  #holding(reach) {
    return !this.calm && !this.leaving && this.nextSourceId == null && reach >= 0.999;
  }

  #startLoops() {
    const motion = TARGET_LINE_MOTION;
    this.loops = [
      animate(this.state, { sweep: [0, 1], duration: motion.sweepPeriodMs, ease: "linear", loop: true }),
      animate(this.state, { spin: [0, TAU], duration: motion.spinPeriodMs, ease: "linear", loop: true }),
      animate(this.state, {
        pulse: [0, 1],
        duration: motion.pulsePeriodMs,
        ease: "inOutSine",
        loop: true,
        alternate: true
      })
    ];
  }

  #freezeLoops() {
    for (const loop of this.loops) loop?.pause?.();
  }

  #resumeLoops() {
    for (const loop of this.loops) loop?.resume?.();
  }
}

function setLine(graphics, width, color, alpha) {
  LINE.width = width;
  LINE.color = color;
  LINE.alpha = alpha;
  LINE.cap = PIXI.LINE_CAP.ROUND;
  LINE.join = PIXI.LINE_JOIN.ROUND;
  graphics.lineStyle(LINE);
}

/** Stroke the stretch of `path` from arc length `start` to `end`, straight from the path buffer. */
function strokePath(graphics, path, start, end, width, color, alpha, point) {
  if (end - start < 0.01 || alpha <= 0.001 || width <= 0) return;
  setLine(graphics, width, color, alpha);
  pointAt(path, start, point);
  graphics.moveTo(point.x, point.y);
  const { xs, ys, arcs } = path;
  const last = xs.length - 1;
  for (let i = 1; i < last; i++) {
    if (arcs[i] > start && arcs[i] < end) graphics.lineTo(xs[i], ys[i]);
  }
  pointAt(path, end, point);
  graphics.lineTo(point.x, point.y);
}

function strokeCircle(graphics, x, y, radius, width, color, alpha) {
  if (alpha <= 0.001 || radius <= 0) return;
  setLine(graphics, width, color, alpha);
  graphics.drawCircle(x, y, radius);
}

function strokeArc(graphics, x, y, radius, start, end, width, color, alpha) {
  if (alpha <= 0.001 || radius <= 0) return;
  setLine(graphics, width, color, alpha);
  graphics.moveTo(x + (Math.cos(start) * radius), y + (Math.sin(start) * radius));
  graphics.arc(x, y, radius, start, end);
}

function fillCircle(graphics, x, y, radius, color, alpha) {
  if (alpha <= 0.001 || radius <= 0) return;
  graphics.lineStyle(0);
  graphics.beginFill(color, alpha);
  graphics.drawCircle(x, y, radius);
  graphics.endFill();
}

/** A filled wedge whose tip sits on `tip`, pointing along its tangent. */
function drawHead(graphics, tip, length, halfWidth, hairline, color, bright, alpha) {
  const baseX = tip.x - (tip.tx * length);
  const baseY = tip.y - (tip.ty * length);
  const nx = -tip.ty * halfWidth;
  const ny = tip.tx * halfWidth;
  setLine(graphics, hairline, bright, 0.95 * alpha);
  graphics.beginFill(color, 0.6 * alpha);
  graphics.moveTo(tip.x, tip.y);
  graphics.lineTo(baseX + nx, baseY + ny);
  graphics.lineTo(baseX - nx, baseY - ny);
  graphics.closePath();
  graphics.endFill();
}

function mixColor(a, b, amount) {
  const mix = (shift) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + ((to - from) * amount)) << shift;
  };
  return mix(16) | mix(8) | mix(0);
}

function lerp(a, b, t) {
  return a + ((b - a) * t);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
