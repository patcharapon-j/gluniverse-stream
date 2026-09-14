import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  MIN_SPAN_SQUARES,
  buildArc,
  lineGeometry,
  quadraticArcLength,
  ringRadius
} from "../scripts/targeting/target-geometry.js";

const GRID = 100;

/** A token of `squares` × `squares` grid squares whose top-left corner is at grid cell (col, row). */
function token(col, row, squares = 1, grid = GRID) {
  const size = squares * grid;
  return { center: { x: (col * grid) + (size / 2), y: (row * grid) + (size / 2) }, size };
}

function geometryBetween(source, target, grid = GRID) {
  return lineGeometry({
    from: source.center,
    to: target.center,
    sourceSize: source.size,
    targetSize: target.size,
    gridSize: grid
  });
}

function visibleSpan(geometry) {
  return geometry.endArc - geometry.startArc;
}

/** The arc and trims exactly as target-line.js drew them before the melee hop. */
function legacyGeometry(source, target, grid = GRID) {
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
  }
  const startArc = Math.min(total, (source.size / 2) * 0.92);
  const endArc = Math.max(startArc, total - ((target.size / 2) * 1.12));
  return { bend, points, length: total, startArc, endArc };
}

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
  test(`melee: ${name} draws a visible body with room for a head`, () => {
    const geometry = geometryBetween(source, target);
    const span = visibleSpan(geometry);
    assert.ok(span >= 0.5 * GRID, `span ${span.toFixed(1)}px is under half a square`);
    assert.ok(span >= (MIN_SPAN_SQUARES * GRID) - 1, `span ${span.toFixed(1)}px is under the minimum`);
    // The flat rule these cases used to get drew no body, a stub, or no room for a head.
    assert.ok(visibleSpan(legacyGeometry(source, target)) < MIN_SPAN_SQUARES * GRID, "case no longer exercises the hop");
  });
}

test("the hop scales with the grid", () => {
  for (const grid of [50, 140, 300]) {
    const geometry = geometryBetween(token(0, 0, 1, grid), token(1, 0, 1, grid), grid);
    assert.ok(visibleSpan(geometry) >= (MIN_SPAN_SQUARES * grid) - (grid / 100), `grid ${grid}`);
  }
});

test("stacked tokens still get a finite hop", () => {
  const geometry = geometryBetween(token(0, 0), token(0, 0));
  for (const point of geometry.path.points) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
  }
  assert.ok(visibleSpan(geometry) >= (MIN_SPAN_SQUARES * GRID) - 1);
});

test("long-range arcs are unchanged from the flat rule", () => {
  const cases = [];
  for (const [col, row] of [[3, 0], [0, 3], [2, 2], [5, 1], [-4, 3], [8, -6], [20, 0], [0, -35]]) {
    for (const sourceSquares of [1, 2]) {
      for (const targetSquares of [1, 2]) {
        cases.push([token(0, 0, sourceSquares), token(col + sourceSquares, row, targetSquares)]);
      }
    }
  }
  for (const [source, target] of cases) {
    const legacy = legacyGeometry(source, target);
    const geometry = geometryBetween(source, target);
    const label = `${JSON.stringify(source.center)} to ${JSON.stringify(target.center)}`;
    assert.ok(Math.abs(geometry.bend - legacy.bend) < 1e-9, `bend changed for ${label}`);
    assert.ok(Math.abs(geometry.startArc - legacy.startArc) < 1e-6, `start changed for ${label}`);
    assert.ok(Math.abs(geometry.endArc - legacy.endArc) < 1e-6, `end changed for ${label}`);
    geometry.path.points.forEach((point, i) => {
      const old = legacy.points[i];
      assert.ok(Math.hypot(point.x - old.x, point.y - old.y) < 1e-6, `point ${i} moved for ${label}`);
    });
  }
});

test("the hop blends in without a jump as tokens close", () => {
  // Where the hop meets the flat rule the bow changes direction of travel with a finite slope (about 4.6px of
  // bend per px of chord at every size, since both scale with the required length). A jump, such as the bow
  // flipping sides or snapping to the flat rule, moves the whole bow at once.
  const MAX_SLOPE = 6;
  for (const [sourceSquares, targetSquares] of [[1, 1], [2, 1], [1, 2], [2, 2]]) {
    let previous = null;
    for (let chord = 0; chord <= 5 * GRID; chord += 1) {
      const source = { center: { x: 0, y: 0 }, size: sourceSquares * GRID };
      const target = { center: { x: chord, y: 0 }, size: targetSquares * GRID };
      const geometry = geometryBetween(source, target);
      if (previous) {
        const label = `${sourceSquares}×${sourceSquares} to ${targetSquares}×${targetSquares} at ${chord}px`;
        assert.ok(Math.abs(geometry.bend - previous.bend) < MAX_SLOPE, `bend jumps for ${label}`);
        assert.ok(Math.abs(geometry.endArc - previous.endArc) < 2, `end jumps for ${label}`);
      }
      previous = geometry;
    }
  }
});

test("the closed-form arc length matches the sampled path", () => {
  for (const [chord, bend] of [[100, 0], [100, 16], [100, 136], [141, 88], [0, 170], [1000, 250]]) {
    const sampled = buildArc({ x: 0, y: 0 }, { x: chord, y: 0 }, bend).length;
    const exact = quadraticArcLength(chord, bend);
    assert.ok(Math.abs(exact - sampled) < 0.5, `closed form ${exact} vs sampled ${sampled} for ${chord}/${bend}`);
    assert.ok(exact >= Math.max(chord, bend) - 1e-9, `length ${exact} for ${chord}/${bend}`);
  }
  const hop = geometryBetween(token(0, 0), token(1, 0));
  assert.ok(Math.abs(quadraticArcLength(GRID, hop.bend) - hop.path.length) < 0.5);
});

test("the reticle radius is unchanged", () => {
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
  near(ringRadius(100), 56);
  near(ringRadius(200), 112);
  near(geometryBetween(token(0, 0), token(4, 0, 2)).ringRadius, 112);
});

test("the geometry module is pure", () => {
  const code = readFileSync(new URL("../scripts/targeting/target-geometry.js", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /^\s*import /m);
  assert.doesNotMatch(code, /\b(PIXI|canvas|game|foundry|Hooks|CONFIG|CONST|window|document)\b/);
});
