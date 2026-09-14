/**
 * Pure geometry for one targeting line: a quadratic arc from the source token to the target token's reticle,
 * sampled by arc length into a reusable buffer. No PIXI or Foundry globals, so it runs under plain Node, and no
 * allocation per call when the caller passes its own path buffer.
 *
 * Distances are canvas pixels. A token's size is its larger side in pixels.
 *
 * Two shapes, blended by how close the tokens are:
 *
 * - At range the line is the range arc, unchanged from before the Etched Bow: a Bézier between the token centres, bowed left of travel by 0.16
 *   of their distance (at most 2.5 squares), cut to start 0.92 of the source's half-size along it and to stop at
 *   the reticle, 1.12 of the target's half-size before its end. A piece of a quadratic Bézier is itself one, so
 *   that cut is kept exactly.
 * - Up close, where that cut leaves nothing between the start and the reticle, the line becomes an arch. The
 *   endpoints slide round the token edges towards the bow side (the shoulder rule, up to 55°) and the bow lifts
 *   to at least a hop, so the arc leaves the source's shoulder and lands on the target's shoulder with a clear
 *   body, instead of degenerating into a needle over the shared edge.
 */

const SAMPLE_COUNT = 40;
const EPSILON = 1e-6;
const BISECTION_STEPS = 30;

/** The body starts just inside the source token's edge, as a share of its half-size. */
export const START_TRIM_SHARE = 0.92;
/** The reticle sits just outside the target token's edge, as a share of its half-size; the body stops at it. */
export const RING_SHARE = 1.12;
/** How far the control point sits off the chord, as a share of its length (capped in grid squares). */
export const BEND_SHARE = 0.16;
export const MAX_BEND_SQUARES = 2.5;
/** Closeness runs from 1 with the token edges touching to 0 once this much edge gap opens between them. */
export const CLOSE_RANGE_SQUARES = 1.2;
/** Shoulder rule: the furthest the endpoints slide round the token edges towards the bow side. */
export const MAX_SHOULDER_RADIANS = (55 * Math.PI) / 180;
/** The least mid-curve lift of the arch with the tokens touching, in grid squares; it fades with closeness. */
export const HOP_SQUARES = 0.45;
/** The arch has fully replaced the range arc by this closeness. */
export const ARCH_ONSET = 0.5;

/**
 * Drawn sizes along the path, in grid squares. They live beside the shares above so that what a melee body is
 * measured against is the head the renderer actually draws.
 */
export const HEAD_LENGTH_SQUARES = 0.26;
export const HEAD_HALF_WIDTH_SQUARES = 0.11;
export const SWEEP_LENGTH_SQUARES = 0.6;

/** The range arc, cut to its visible part, for the blend: x0, y0, cx, cy, x1, y1. */
const rangeArc = new Float64Array(6);

export function ringRadius(targetSize) {
  return (targetSize / 2) * RING_SHARE;
}

/** A path buffer for `lineGeometry` to fill. Hold one per line and pass it every frame. */
export function createPath() {
  return {
    xs: new Float64Array(SAMPLE_COUNT + 1),
    ys: new Float64Array(SAMPLE_COUNT + 1),
    arcs: new Float64Array(SAMPLE_COUNT + 1),
    length: 0,
    closeness: 0
  };
}

/**
 * @param {{from: {x: number, y: number}, to: {x: number, y: number}, sourceSize: number, targetSize: number,
 *   gridSize: number}} options
 * @param {ReturnType<typeof createPath>} [path]  filled in place and returned
 */
export function lineGeometry({ from, to, sourceSize, targetSize, gridSize }, path = createPath()) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  // Tokens stacked on one spot have no direction of travel; this one bows straight up the screen.
  const ux = distance > EPSILON ? dx / distance : -1;
  const uy = distance > EPSILON ? dy / distance : 0;
  // The bow side, left of travel in screen space: the side the range arc has always bowed to.
  const nx = -uy;
  const ny = ux;
  const startTrim = (sourceSize / 2) * START_TRIM_SHARE;
  const ring = ringRadius(targetSize);
  const edgeGap = Math.max(0, distance - startTrim - ring);
  const closeness = clamp01(1 - (edgeGap / (CLOSE_RANGE_SQUARES * gridSize)));
  const archWeight = clamp01(closeness / ARCH_ONSET);

  // The arch: shoulder-to-shoulder endpoints, a bow of at least the hop.
  const shoulder = MAX_SHOULDER_RADIANS * closeness;
  const cos = Math.cos(shoulder);
  const sin = Math.sin(shoulder);
  let x0 = from.x + (startTrim * ((cos * ux) + (sin * nx)));
  let y0 = from.y + (startTrim * ((cos * uy) + (sin * ny)));
  let x1 = to.x + (ring * ((sin * nx) - (cos * ux)));
  let y1 = to.y + (ring * ((sin * ny) - (cos * uy)));
  const chordX = x1 - x0;
  const chordY = y1 - y0;
  const chord = Math.hypot(chordX, chordY);
  const offset = Math.max(
    Math.min(chord * BEND_SHARE, MAX_BEND_SQUARES * gridSize),
    2 * HOP_SQUARES * gridSize * closeness
  );
  // Bow off the chord's own normal at range, easing onto the travel normal as the tokens close, so overlapping
  // tokens (whose shoulder chord can point backwards) never flip the arch to the other side.
  let mx = chord > EPSILON ? -chordY / chord : nx;
  let my = chord > EPSILON ? chordX / chord : ny;
  mx = (mx * (1 - closeness)) + (nx * closeness);
  my = (my * (1 - closeness)) + (ny * closeness);
  const normal = Math.hypot(mx, my) || 1;
  let cx = ((x0 + x1) / 2) + ((offset * mx) / normal);
  let cy = ((y0 + y1) / 2) + ((offset * my) / normal);

  if (archWeight < 1) {
    // Only reached with the edges at least 0.6 squares apart, so the direction of travel is well defined.
    cutRangeArc(from, to, distance, ux, uy, startTrim, ring, gridSize);
    const keep = 1 - archWeight;
    x0 = (rangeArc[0] * keep) + (x0 * archWeight);
    y0 = (rangeArc[1] * keep) + (y0 * archWeight);
    cx = (rangeArc[2] * keep) + (cx * archWeight);
    cy = (rangeArc[3] * keep) + (cy * archWeight);
    x1 = (rangeArc[4] * keep) + (x1 * archWeight);
    y1 = (rangeArc[5] * keep) + (y1 * archWeight);
  }

  sampleCurve(path, x0, y0, cx, cy, x1, y1);
  path.closeness = closeness;
  return path;
}

/** The point `arc` along a path and the unit tangent there, written into `out`. */
export function pointAt(path, arc, out = { x: 0, y: 0, tx: 1, ty: 0 }) {
  const { xs, ys, arcs } = path;
  const clamped = Math.max(0, Math.min(path.length, arc));
  let index = 1;
  while (index < SAMPLE_COUNT && arcs[index] < clamped) index++;
  const segment = (arcs[index] - arcs[index - 1]) || 1;
  const t = (clamped - arcs[index - 1]) / segment;
  const dx = xs[index] - xs[index - 1];
  const dy = ys[index] - ys[index - 1];
  const length = Math.hypot(dx, dy) || 1;
  out.x = xs[index - 1] + (dx * t);
  out.y = ys[index - 1] + (dy * t);
  out.tx = dx / length;
  out.ty = dy / length;
  return out;
}

/**
 * The range arc between the token centres, cut from `startTrim` along it to `ring` before its end. The piece of a
 * quadratic Bézier on [t0, t1] has endpoints B(t0), B(t1) and control point B's blossom at (t0, t1).
 */
function cutRangeArc(from, to, distance, ux, uy, startTrim, ring, gridSize) {
  const bend = Math.min(distance * BEND_SHARE, MAX_BEND_SQUARES * gridSize);
  const px = ((from.x + to.x) / 2) - (uy * bend);
  const py = ((from.y + to.y) / 2) + (ux * bend);
  const total = arcLengthTo(1, distance, bend);
  const start = Math.min(total, startTrim);
  const end = Math.max(start, total - ring);
  const t0 = parameterAt(start, distance, bend, total);
  const t1 = parameterAt(end, distance, bend, total);
  const a = (1 - t0) * (1 - t1);
  const b = ((1 - t0) * t1) + (t0 * (1 - t1));
  const c = t0 * t1;
  rangeArc[0] = bezier(from.x, px, to.x, t0);
  rangeArc[1] = bezier(from.y, py, to.y, t0);
  rangeArc[2] = (a * from.x) + (b * px) + (c * to.x);
  rangeArc[3] = (a * from.y) + (b * py) + (c * to.y);
  rangeArc[4] = bezier(from.x, px, to.x, t1);
  rangeArc[5] = bezier(from.y, py, to.y, t1);
}

/**
 * Exact arc length from 0 to `t` of the symmetric quadratic Bézier with endpoints `chord` apart and its control
 * point `bend` off their midpoint: its speed is √(chord² + (2·bend·(1 − 2t))²).
 */
function arcLengthTo(t, chord, bend) {
  const h = Math.abs(bend);
  if (h <= EPSILON * chord) return chord * t;
  return (speedPrimitive(2 * h, chord) - speedPrimitive(2 * h * (1 - (2 * t)), chord)) / (4 * h);
}

function speedPrimitive(v, chord) {
  return ((v / 2) * Math.hypot(chord, v)) + (((chord * chord) / 2) * Math.asinh(v / chord));
}

function parameterAt(arc, chord, bend, total) {
  if (arc <= 0) return 0;
  if (arc >= total) return 1;
  let low = 0;
  let high = 1;
  for (let i = 0; i < BISECTION_STEPS; i++) {
    const mid = (low + high) / 2;
    if (arcLengthTo(mid, chord, bend) < arc) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
}

function sampleCurve(path, x0, y0, cx, cy, x1, y1) {
  const { xs, ys, arcs } = path;
  let total = 0;
  for (let i = 0; i <= SAMPLE_COUNT; i++) {
    const t = i / SAMPLE_COUNT;
    const x = bezier(x0, cx, x1, t);
    const y = bezier(y0, cy, y1, t);
    if (i > 0) total += Math.hypot(x - xs[i - 1], y - ys[i - 1]);
    xs[i] = x;
    ys[i] = y;
    arcs[i] = total;
  }
  path.length = total;
}

function bezier(p, c, q, t) {
  const u = 1 - t;
  return (u * u * p) + (2 * u * t * c) + (t * t * q);
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}
