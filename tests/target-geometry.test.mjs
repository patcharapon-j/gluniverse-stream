import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CLOSE_RANGE_SQUARES,
  createPath,
  lineGeometry,
  pointAt,
  ringRadius
} from "../scripts/targeting/target-geometry.js";

const GRID = 100;
/** The Etched Bow head is a wedge this long (target-line.js); the body has to leave room for it. */
const HEAD_SQUARES = 0.26;

/** A token of `squares` × `squares` grid squares whose top-left corner is at grid cell (col, row). */
function token(col, row, squares = 1, grid = GRID) {
  const size = squares * grid;
  return { center: { x: (col * grid) + (size / 2), y: (row * grid) + (size / 2) }, size };
}

function geometryBetween(source, target, grid = GRID, out = undefined) {
  return lineGeometry({
    from: source.center,
    to: target.center,
    sourceSize: source.size,
    targetSize: target.size,
    gridSize: grid
  }, out);
}

function pointsOf(path) {
  return Array.from(path.xs, (x, i) => ({ x, y: path.ys[i] }));
}

/** Today's visible arc, exactly as target-line.js drew it before the Etched Bow: 81 points along the trim. */
function legacyVisible(source, target, grid = GRID) {
  const from = source.center;
  const to = target.center;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  const bend = Math.min(length * 0.16, 2.5 * grid);
  const control = {
    x: ((from.x + to.x) / 2) - ((dy / length) * bend),
    y: ((from.y + to.y) / 2) + ((dx / length) * bend)
  };
  const points = [];
  const arcs = [];
  let total = 0;
  for (let i = 0; i <= 40; i++) {
    const t = i / 40;
    const u = 1 - t;
    const point = {
      x: (u * u * from.x) + (2 * u * t * control.x) + (t * t * to.x),
      y: (u * u * from.y) + (2 * u * t * control.y) + (t * t * to.y)
    };
    if (i > 0) total += Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y);
    points.push(point);
    arcs.push(total);
  }
  const at = arc => {
    let index = 1;
    while (index < arcs.length - 1 && arcs[index] < arc) index++;
    const a = points[index - 1];
    const b = points[index];
    const t = (arc - arcs[index - 1]) / ((arcs[index] - arcs[index - 1]) || 1);
    return { x: a.x + ((b.x - a.x) * t), y: a.y + ((b.y - a.y) * t) };
  };
  const start = Math.min(total, (source.size / 2) * 0.92);
  const end = Math.max(start, total - ((target.size / 2) * 1.12));
  return Array.from({ length: 81 }, (_, i) => at(start + ((end - start) * i / 80)));
}

function distanceToPolyline(point, polyline) {
  let best = Infinity;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const t = Math.min(1, Math.max(0, (((point.x - a.x) * vx) + ((point.y - a.y) * vy)) / (((vx * vx) + (vy * vy)) || 1)));
    best = Math.min(best, Math.hypot(point.x - a.x - (vx * t), point.y - a.y - (vy * t)));
  }
  return best;
}

function hausdorff(a, b) {
  return Math.max(...a.map(p => distanceToPolyline(p, b)), ...b.map(p => distanceToPolyline(p, a)));
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const MELEE_CASES = [
  ["1×1 side by side, left to right", token(0, 0), token(1, 0)],
  ["1×1 side by side, right to left", token(1, 0), token(0, 0)],
  ["1×1 stacked vertically", token(0, 0), token(0, 1)],
  ["1×1 diagonal", token(0, 0), token(1, 1)],
  ["1×1 diagonal, up and left", token(1, 1), token(0, 0)],
  ["2×2 attacking an adjacent 1×1", token(0, 0, 2), token(2, 0)],
  ["1×1 attacking an adjacent 2×2", token(2, 1), token(0, 0, 2)],
  ["2×2 attacking a 1×1 at its corner", token(0, 0, 2), token(2, 2)],
  ["1×1 below a 2×2", token(1, 2), token(0, 0, 2)]
];

for (const [name, source, target] of MELEE_CASES) {
  test(`melee: ${name} arches a clear body and lands the head on the reticle`, () => {
    const path = geometryBetween(source, target);
    const ring = ringRadius(target.size);
    assert.ok(path.length >= 0.8 * GRID, `body ${(path.length / GRID).toFixed(2)} sq is not clearly visible`);
    assert.ok(path.length - (HEAD_SQUARES * GRID) >= 0.5 * GRID, "half a square of body shows behind the head");

    const tip = pointAt(path, path.length);
    assert.ok(Math.abs(distance(tip, target.center) - ring) < 0.5, "the tip lands on the reticle");
    const inward = { x: target.center.x - tip.x, y: target.center.y - tip.y };
    const landing = Math.acos(((tip.tx * inward.x) + (tip.ty * inward.y)) / Math.hypot(inward.x, inward.y));
    assert.ok(landing <= Math.PI / 4, `head skims the reticle at ${(landing * 180 / Math.PI).toFixed(0)}°`);
    pointsOf(path).slice(0, -1).forEach((point, i) => {
      assert.ok(distance(point, target.center) >= ring - 0.5, `sample ${i} cuts inside the reticle`);
    });
    const base = pointAt(path, path.length - (HEAD_SQUARES * GRID));
    assert.ok(distance(base, target.center) >= ring + (0.2 * GRID), "the head's base clears the reticle");

    // The arch rises on today's side: left of travel, (−dy, dx) in screen coordinates.
    const dx = target.center.x - source.center.x;
    const dy = target.center.y - source.center.y;
    const mid = pointAt(path, path.length / 2);
    const centreMid = { x: (source.center.x + target.center.x) / 2, y: (source.center.y + target.center.y) / 2 };
    assert.ok(((mid.x - centreMid.x) * -dy) + ((mid.y - centreMid.y) * dx) > 0, "bow is on the left of travel");
  });
}

test("melee bodies scale with the grid", () => {
  for (const grid of [50, 140, 300]) {
    const path = geometryBetween(token(0, 0, 1, grid), token(1, 0, 1, grid), grid);
    assert.ok(path.length >= 0.8 * grid, `grid ${grid}`);
  }
});

test("stacked tokens still get a finite arch", () => {
  const path = geometryBetween(token(0, 0), token(0, 0));
  for (const point of pointsOf(path)) assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  assert.ok(path.length >= 0.5 * GRID);
});

test("long-range arcs are today's visible arc", () => {
  let checked = 0;
  for (const [col, row] of [[3, 0], [0, 3], [2, 2], [5, 1], [-4, 3], [8, -6], [20, 0], [0, -35], [30, 25]]) {
    for (const sourceSquares of [1, 2]) {
      for (const targetSquares of [1, 2]) {
        const source = token(0, 0, sourceSquares);
        const target = token(col + sourceSquares, row, targetSquares);
        const path = geometryBetween(source, target);
        const gap = distance(source.center, target.center) - (source.size / 2 * 0.92) - (target.size / 2 * 1.12);
        if (gap < CLOSE_RANGE_SQUARES * GRID) continue;
        assert.equal(path.closeness, 0);
        const deviation = hausdorff(pointsOf(path), legacyVisible(source, target));
        assert.ok(deviation <= 1, `moved ${deviation.toFixed(2)}px for ${JSON.stringify([col, row, sourceSquares, targetSquares])}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 30);
});

test("the arch never draws less body than today's arc", () => {
  for (const [sourceSquares, targetSquares] of [[1, 1], [2, 1], [1, 2]]) {
    for (let gap = 0; gap <= 5 * GRID; gap += 5) {
      const source = { center: { x: 0, y: 0 }, size: sourceSquares * GRID };
      const target = { center: { x: gap, y: gap * 0.5 }, size: targetSquares * GRID };
      const legacy = legacyVisible(source, target);
      let legacyLength = 0;
      for (let i = 1; i < legacy.length; i++) legacyLength += distance(legacy[i], legacy[i - 1]);
      const path = geometryBetween(source, target);
      assert.ok(path.length >= legacyLength - 1, `${sourceSquares}×→${targetSquares}× at ${gap}px`);
    }
  }
});

test("the arch blends in without a jump as tokens close", () => {
  // The only discontinuity is at exactly zero distance, where the direction of travel is undefined.
  const MAX_STEP = 4;
  for (const [sourceSquares, targetSquares] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    for (const [ux, uy] of [[1, 0], [Math.SQRT1_2, Math.SQRT1_2], [-0.6, 0.8]]) {
      let previous = null;
      for (let d = 1; d <= 6 * GRID; d += 1) {
        const source = { center: { x: 0, y: 0 }, size: sourceSquares * GRID };
        const target = { center: { x: ux * d, y: uy * d }, size: targetSquares * GRID };
        const points = pointsOf(geometryBetween(source, target));
        if (previous) {
          const step = Math.max(...points.map((point, i) => distance(point, previous[i])));
          assert.ok(step < MAX_STEP, `${step.toFixed(1)}px jump at ${d}px for ${sourceSquares}×→${targetSquares}× (${ux},${uy})`);
        }
        previous = points;
      }
    }
  }
});

test("geometry reuses the caller's path buffer", () => {
  const out = createPath();
  assert.equal(geometryBetween(token(0, 0), token(5, 0), GRID, out), out);
  const xs = out.xs;
  assert.equal(geometryBetween(token(0, 0), token(1, 0), GRID, out), out);
  assert.equal(out.xs, xs);
  const scratch = { x: 0, y: 0, tx: 0, ty: 0 };
  assert.equal(pointAt(out, 10, scratch), scratch);
});

test("the reticle radius is unchanged", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  near(ringRadius(100), 56);
  near(ringRadius(200), 112);
});

test("the geometry module is pure", () => {
  const code = readFileSync(new URL("../scripts/targeting/target-geometry.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import /m);
  assert.doesNotMatch(code, /\b(PIXI|canvas|game|foundry|Hooks|CONFIG|CONST|window|document)\b/);
});
