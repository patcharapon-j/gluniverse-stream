/**
 * Pure geometry for one targeting line: the arc from a source token's centre to a target token's centre,
 * where along it the drawn body starts and stops, and the reticle radius. No PIXI or Foundry globals, so
 * it runs under plain Node.
 *
 * Distances are canvas pixels. A token's size is its larger side in pixels.
 */

const ARC_SAMPLES = 40;
/** How far the arc bows out sideways, as a share of its chord (capped in grid squares). */
export const BEND_SHARE = 0.16;
export const MAX_BEND_SQUARES = 2.5;
/** The body starts just inside the source token's edge, as a share of its half-size. */
export const START_TRIM_SHARE = 0.92;
/** The reticle sits just outside the target token's edge, as a share of its half-size; the body stops at it. */
export const RING_SHARE = 1.12;
/**
 * The shortest body a line will draw, in grid squares of path between the start trim and the reticle: half
 * a square of line plus room for a head.
 *
 * Up close the start trim and the reticle eat the whole chord, so a flat arc between adjacent tokens has no
 * body at all. Instead the arc lifts into a hop, bowing out just far enough for its body to be this long.
 * At range the flat rule already clears it and the arc is untouched.
 */
export const MIN_SPAN_SQUARES = 0.7;
const BISECTION_STEPS = 32;

export function ringRadius(targetSize) {
  return (targetSize / 2) * RING_SHARE;
}

/**
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}, sourceSize: number, targetSize: number,
 *   gridSize: number}} options
 * @returns {{path: {points: {x: number, y: number}[], arcs: number[], length: number}, bend: number,
 *   startArc: number, endArc: number, ringRadius: number}}
 */
export function lineGeometry({ from, to, sourceSize, targetSize, gridSize }) {
  const chord = Math.hypot(to.x - from.x, to.y - from.y);
  const startTrim = (sourceSize / 2) * START_TRIM_SHARE;
  const ring = ringRadius(targetSize);
  const bend = arcBend(chord, startTrim + ring + (MIN_SPAN_SQUARES * gridSize), gridSize);
  const path = buildArc(from, to, bend);
  const startArc = Math.min(path.length, startTrim);
  const endArc = Math.max(startArc, path.length - ring);
  return { path, bend, startArc, endArc, ringRadius: ring };
}

/**
 * The flat rule's bend, raised just enough that the arc is at least `minLength` long. Arc length only grows
 * with the bend, so the smallest sufficient bend is found by bisection on the closed form. The hop meets the
 * flat rule exactly where the flat rule stops being long enough, so closing tokens never see the arc jump.
 */
export function arcBend(chord, minLength, gridSize) {
  const flat = Math.min(chord * BEND_SHARE, MAX_BEND_SQUARES * gridSize);
  if (quadraticArcLength(chord, flat) >= minLength) return flat;
  // An arc bowed by `minLength` is at least that long: it travels out to half its bend and back.
  let low = flat;
  let high = Math.max(flat, minLength);
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (low + high) / 2;
    if (quadraticArcLength(chord, mid) >= minLength) high = mid;
    else low = mid;
  }
  return high;
}

/**
 * Exact length of the symmetric quadratic Bézier `buildArc` draws: endpoints `chord` apart, control point
 * `bend` off their midpoint.
 */
export function quadraticArcLength(chord, bend) {
  const c = Math.abs(chord);
  const h = Math.abs(bend);
  if (h < 1e-9) return c;
  if (c < 1e-9) return h;
  return (Math.hypot(c, 2 * h) / 2) + (((c * c) / (4 * h)) * Math.asinh((2 * h) / c));
}

/** A quadratic Bézier from `from` to `to`, bowed to the left of travel by `bend`, sampled by arc length. */
export function buildArc(from, to, bend) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  // Tokens stacked on one spot have no direction of travel; hop straight up the screen.
  const normal = length > 1e-9 ? { x: -dy / length, y: dx / length } : { x: 0, y: -1 };
  const control = {
    x: ((from.x + to.x) / 2) + (normal.x * bend),
    y: ((from.y + to.y) / 2) + (normal.y * bend)
  };
  const points = [];
  const arcs = [];
  let total = 0;
  for (let i = 0; i <= ARC_SAMPLES; i++) {
    const t = i / ARC_SAMPLES;
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

export function sampleAt(path, arc) {
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

export function slicePath(path, startArc, endArc) {
  const points = [sampleAt(path, startArc).point];
  for (let i = 0; i < path.points.length; i++) {
    if (path.arcs[i] > startArc && path.arcs[i] < endArc) points.push(path.points[i]);
  }
  points.push(sampleAt(path, endArc).point);
  return points;
}
