import { animate, remove } from "../motion/engine.js";

const SAMPLES = 40;
/** How far the arc bows out sideways, as a share of its length (capped in grid squares). */
const BEND_SHARE = 0.16;
const MAX_BEND_SQUARES = 2.5;
const CHEVRON_SPACING_SQUARES = 0.85;
const CHEVRON_SIZE_SQUARES = 0.2;
const FLOW_PERIOD_MS = 900;
const SPIN_PERIOD_MS = 6000;
const PULSE_PERIOD_MS = 1400;
const DRAW_MS = 560;
const RETRACT_MS = 380;
const RING_ARCS = 3;
const RING_ARC_SPAN = Math.PI * 0.38;
const TAU = Math.PI * 2;

/**
 * One glowing, arcing targeting line from a source token to a target token, in the style of Final
 * Fantasy XII's gambit lines: it draws out from the source, pops a spinning reticle around the target,
 * streams chevrons toward the target while it holds, and retracts into the source when it goes away.
 *
 * anime.js drives every animated value on `state`; `render` turns that state and the tokens' current
 * (animated) positions into PIXI geometry once per canvas frame. A line targeting its own source draws
 * only the reticle.
 */
export class TargetLine {
  state = { reach: 0, ring: 0, opacity: 1, flow: 0, spin: 0, pulse: 0 };
  leaving = false;
  destroyed = false;

  constructor({ sourceId, targetId, halo, core, style, calm, onGone }) {
    this.sourceId = sourceId;
    this.targetId = targetId;
    this.style = style;
    this.calm = calm;
    this.onGone = onGone;
    this.haloGraphics = halo.addChild(new PIXI.Graphics());
    this.coreGraphics = core.addChild(new PIXI.Graphics());
    this.coreGraphics.blendMode = PIXI.BLEND_MODES.ADD;
    if (!calm) this.#startLoops();
  }

  get isSelfTarget() {
    return this.sourceId === this.targetId;
  }

  setStyle(style) {
    this.style = style;
  }

  /** Draw the line in, or, if it is on its way out, turn it around from wherever it has got to. */
  show() {
    if (this.destroyed) return;
    const firstShow = !this.shown;
    if (!firstShow && !this.leaving) return;
    this.shown = true;
    this.leaving = false;
    const state = this.state;
    if (this.calm) {
      state.reach = 1;
      state.ring = 1;
      if (firstShow) state.opacity = 0;
      animate(state, { opacity: 1, duration: 420, ease: "outQuad" });
      return;
    }
    state.opacity = 1;
    const reachMs = this.isSelfTarget ? 0 : DRAW_MS * (1 - state.reach);
    animate(state, { reach: 1, duration: Math.max(1, reachMs), ease: "outCubic" });
    animate(state, { ring: 1, duration: 480, delay: Math.max(0, reachMs - 160), ease: "outBack(2.2)" });
  }

  /** Retract into the source (or fade, in calm mode), then remove the line. */
  hide() {
    if (this.destroyed || this.leaving) return;
    this.leaving = true;
    const finish = () => {
      if (this.leaving) this.destroy();
    };
    const state = this.state;
    if (this.calm) {
      animate(state, { opacity: 0, duration: 320, ease: "inQuad", onComplete: finish });
      return;
    }
    animate(state, { ring: 0, duration: 220, ease: "inCubic" });
    animate(state, {
      reach: 0,
      duration: this.isSelfTarget ? 240 : Math.max(1, RETRACT_MS * state.reach),
      delay: 80,
      ease: "inCubic",
      onComplete: finish
    });
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    remove(this.state);
    if (!this.haloGraphics.destroyed) this.haloGraphics.destroy();
    if (!this.coreGraphics.destroyed) this.coreGraphics.destroy();
    this.onGone?.(this);
  }

  render({ source, target, scale, gridSize }) {
    const halo = this.haloGraphics;
    const core = this.coreGraphics;
    halo.clear();
    core.clear();
    if (this.destroyed || !source?.document || !target?.document) return;

    const { color, intensity } = this.style;
    const state = this.state;
    const bright = mixColor(color, 0xffffff, 0.65);
    const opacity = clamp01(state.opacity);
    // Widths are authored in screen pixels and only partly follow the zoom, so the line stays legible
    // when the camera pulls back and does not turn into a rope when it pushes in.
    const unit = Math.max(0.5, intensity) / Math.pow(Math.max(0.05, scale), 0.65);
    const glow = this.calm ? 0.9 : 0.8 + (0.2 * state.pulse);
    halo.alpha = opacity;
    core.alpha = opacity;

    const from = source.center;
    const to = target.center;
    const ringRadius = (Math.max(target.w, target.h) / 2) * 1.12;

    if (!this.isSelfTarget) {
      const path = buildArc(from, to, gridSize);
      const startArc = Math.min(path.length, (Math.max(source.w, source.h) / 2) * 0.92);
      const endArc = Math.max(startArc, path.length - ringRadius);
      const visibleEnd = startArc + ((endArc - startArc) * clamp01(state.reach));
      if (visibleEnd - startArc > 1) {
        const points = slicePath(path, startArc, visibleEnd);
        strokePath(halo, points, 18 * unit, color, 0.4 * glow);
        strokePath(core, points, 8 * unit, color, 0.3 * glow);
        strokePath(core, points, 3.4 * unit, color, 0.95);
        strokePath(core, points, 1.4 * unit, bright, 0.9);
        drawOrigin(core, points[0], unit, bright);
        if (!this.calm) {
          this.#drawChevrons(core, path, startArc, visibleEnd, endArc, gridSize, unit, bright);
          if (state.reach < 0.999) drawSpark(halo, core, points[points.length - 1], unit, color, bright);
        }
      }
    }

    if (state.ring > 0.001) this.#drawReticle(halo, core, to, ringRadius, unit, color, bright, glow);
  }

  #startLoops() {
    animate(this.state, { flow: [0, 1], duration: FLOW_PERIOD_MS, ease: "linear", loop: true });
    animate(this.state, { spin: [0, TAU], duration: SPIN_PERIOD_MS, ease: "linear", loop: true });
    animate(this.state, { pulse: [0, 1], duration: PULSE_PERIOD_MS, ease: "inOutSine", loop: true, alternate: true });
  }

  #drawChevrons(graphics, path, startArc, visibleEnd, endArc, gridSize, unit, color) {
    const spacing = CHEVRON_SPACING_SQUARES * gridSize;
    const size = CHEVRON_SIZE_SQUARES * gridSize;
    const span = endArc - startArc;
    if (span < spacing * 0.8) return;
    const fadeLength = Math.min(spacing, span / 3);
    for (let arc = startArc + (this.state.flow * spacing); arc < visibleEnd - (size * 0.5); arc += spacing) {
      const fade = Math.min(clamp01((arc - startArc) / fadeLength), clamp01((endArc - arc) / fadeLength));
      if (fade <= 0.01) continue;
      const { point, tangent } = sampleAt(path, arc);
      const normal = { x: -tangent.y, y: tangent.x };
      const tip = { x: point.x + (tangent.x * size * 0.5), y: point.y + (tangent.y * size * 0.5) };
      const back = { x: point.x - (tangent.x * size * 0.5), y: point.y - (tangent.y * size * 0.5) };
      graphics.lineStyle({ width: 2.4 * unit, color, alpha: 0.95 * fade, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      graphics.moveTo(back.x + (normal.x * size * 0.55), back.y + (normal.y * size * 0.55));
      graphics.lineTo(tip.x, tip.y);
      graphics.lineTo(back.x - (normal.x * size * 0.55), back.y - (normal.y * size * 0.55));
    }
  }

  #drawReticle(halo, core, center, radius, unit, color, bright, glow) {
    const ring = this.state.ring;
    // Pops in from wider than the token and settles onto it.
    const r = radius * (1 + ((1 - Math.min(1, ring)) * 0.6));
    const alpha = clamp01(ring);
    const spin = this.calm ? 0 : this.state.spin;

    halo.lineStyle({ width: 12 * unit, color, alpha: 0.35 * alpha * glow });
    halo.drawCircle(center.x, center.y, r);

    core.lineStyle({ width: 1.6 * unit, color, alpha: 0.45 * alpha });
    core.drawCircle(center.x, center.y, r);
    for (let i = 0; i < RING_ARCS; i++) {
      const start = spin + ((TAU / RING_ARCS) * i);
      strokeArc(core, center, r, start, start + RING_ARC_SPAN, 3.6 * unit, color, 0.95 * alpha);
      strokeArc(core, center, r, start, start + RING_ARC_SPAN, 1.4 * unit, bright, 0.85 * alpha);
    }
    for (let i = 0; i < 4; i++) {
      const angle = (Math.PI / 4) + (i * Math.PI / 2) - (spin * 0.5);
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      core.lineStyle({ width: 2.6 * unit, color: bright, alpha: 0.9 * alpha, cap: PIXI.LINE_CAP.ROUND });
      core.moveTo(center.x + (cos * r * 1.16), center.y + (sin * r * 1.16));
      core.lineTo(center.x + (cos * r * 0.94), center.y + (sin * r * 0.94));
    }
  }
}

/** A quadratic Bézier from `from` to `to`, bowed to the left of travel, sampled by arc length. */
function buildArc(from, to, gridSize) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(length * BEND_SHARE, MAX_BEND_SQUARES * gridSize);
  const control = {
    x: ((from.x + to.x) / 2) - ((dy / length) * bend),
    y: ((from.y + to.y) / 2) + ((dx / length) * bend)
  };
  const points = [];
  const arcs = [];
  let total = 0;
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    const point = {
      x: (u * u * from.x) + (2 * u * t * control.x) + (t * t * to.x),
      y: (u * u * from.y) + (2 * u * t * control.y) + (t * t * to.y)
    };
    if (i > 0) total += Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y);
    points.push(point);
    arcs.push(total);
  }
  return { points, arcs, length: total };
}

function sampleAt(path, arc) {
  const { points, arcs } = path;
  const clamped = Math.max(0, Math.min(path.length, arc));
  let index = 1;
  while (index < arcs.length - 1 && arcs[index] < clamped) index++;
  const a = points[index - 1];
  const b = points[index];
  const segment = (arcs[index] - arcs[index - 1]) || 1;
  const t = (clamped - arcs[index - 1]) / segment;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    point: { x: a.x + (dx * t), y: a.y + (dy * t) },
    tangent: { x: dx / length, y: dy / length }
  };
}

function slicePath(path, startArc, endArc) {
  const points = [sampleAt(path, startArc).point];
  for (let i = 0; i < path.points.length; i++) {
    if (path.arcs[i] > startArc && path.arcs[i] < endArc) points.push(path.points[i]);
  }
  points.push(sampleAt(path, endArc).point);
  return points;
}

function strokePath(graphics, points, width, color, alpha) {
  graphics.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
  graphics.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) graphics.lineTo(points[i].x, points[i].y);
}

function strokeArc(graphics, center, radius, start, end, width, color, alpha) {
  graphics.lineStyle({ width, color, alpha, cap: PIXI.LINE_CAP.ROUND });
  graphics.moveTo(center.x + (Math.cos(start) * radius), center.y + (Math.sin(start) * radius));
  graphics.arc(center.x, center.y, radius, start, end);
}

function drawOrigin(graphics, point, unit, color) {
  graphics.lineStyle(0);
  graphics.beginFill(color, 0.9);
  graphics.drawCircle(point.x, point.y, 3.2 * unit);
  graphics.endFill();
}

function drawSpark(halo, core, point, unit, color, bright) {
  halo.lineStyle(0);
  halo.beginFill(color, 0.8);
  halo.drawCircle(point.x, point.y, 12 * unit);
  halo.endFill();
  core.lineStyle(0);
  core.beginFill(bright, 1);
  core.drawCircle(point.x, point.y, 4.5 * unit);
  core.endFill();
}

function mixColor(a, b, amount) {
  const mix = (shift) => {
    const from = (a >> shift) & 0xff;
    const to = (b >> shift) & 0xff;
    return Math.round(from + ((to - from) * amount)) << shift;
  };
  return mix(16) | mix(8) | mix(0);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, Number(value) || 0));
}
