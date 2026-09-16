import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  ART_ASPECT, cropForFace, defaultCrop, fromFocus, isFocus, pickFace, placement, tileWindows, toFocus
} from "../scripts/framing/focus-math.js";

const det = (score, x, y, size = 40) => ({ score, box: { x, y, width: size, height: size } });

describe("pickFace", () => {
  test("merges overlapping hits into votes and prefers the best-supported face", () => {
    const face = pickFace([det(0.8, 100, 60), det(0.7, 104, 62), det(0.6, 98, 58), det(0.9, 20, 200)], 374, 512);
    assert.equal(face.votes, 3);
    assert.equal(face.box.x, 100);
  });

  test("a lone middling hit is rejected, a lone confident one kept", () => {
    assert.equal(pickFace([det(0.53, 100, 60), det(0.5, 102, 61)], 374, 512), null, "Chk-Chk's staff: 0.53 across two windows");
    assert.equal(pickFace([det(0.77, 100, 10)], 374, 512).score, 0.77, "Grimmyr: one confident window");
  });

  test("several windows agreeing on a fair score are enough", () => {
    const face = pickFace([det(0.49, 150, 90), det(0.45, 152, 92), det(0.4, 149, 88), det(0.3, 151, 91)], 374, 512);
    assert.equal(face.votes, 4, "Ulka: 0.49 seen four times");
  });

  test("in tall art a hit below the middle is not a face", () => {
    assert.equal(pickFace([det(0.76, 150, 300), det(0.7, 152, 302), det(0.7, 148, 298)], 374, 512), null, "Whirp's chest plate");
    assert.ok(pickFace([det(0.76, 150, 300)], 512, 512), "square token art allows lower faces");
  });
});

describe("crops", () => {
  test("a face crop has the art aspect and stays inside the image", () => {
    const crop = cropForFace({ x: 170, y: 20, width: 40, height: 40 }, 374, 512);
    assert.ok(Math.abs(crop.width / crop.height - ART_ASPECT) < 1e-9);
    assert.ok(crop.x >= 0 && crop.y >= 0 && crop.x + crop.width <= 374 && crop.y + crop.height <= 512);
    assert.ok(crop.x < 170 && crop.x + crop.width > 210, "the face is inside the crop");
  });

  test("a face larger than the frame allows falls back to the full width", () => {
    const crop = cropForFace({ x: 0, y: 0, width: 300, height: 300 }, 374, 512);
    assert.equal(crop.width, 374);
  });

  test("the default crop is full width near the top", () => {
    const crop = defaultCrop(374, 512);
    assert.equal(crop.width, 374);
    assert.ok(crop.y > 0 && crop.y < 512 - crop.height);
  });

  test("focus round-trips through pixel crops", () => {
    const crop = cropForFace({ x: 170, y: 20, width: 40, height: 40 }, 374, 512);
    const focus = toFocus(crop, 374);
    assert.ok(isFocus(focus));
    const back = fromFocus(focus, 374, 512);
    for (const key of ["x", "y", "width"]) assert.ok(Math.abs(back[key] - crop[key]) < 0.05, key);
  });

  test("placement scales and shifts the image by box widths", () => {
    assert.deepEqual(placement({ x: 0.25, y: 0.1, w: 0.5 }), { scale: 2, left: -0.5, top: -0.2 });
  });

  test("isFocus rejects junk", () => {
    assert.equal(isFocus(null), false);
    assert.equal(isFocus({ x: 0, y: 0, w: 0 }), false);
    assert.equal(isFocus({ x: 0, y: 0, w: 2 }), false);
    assert.equal(isFocus({ x: "a", y: 0, w: 0.5 }), false);
  });
});

test("tile windows cover the upper image at two zoom levels", () => {
  const windows = tileWindows(374, 512);
  assert.ok(windows.length > 10);
  assert.ok(windows.every(w => w.y + w.size <= 512 * 0.75 + 1 && w.x + w.size <= 374 + 1));
  assert.equal(new Set(windows.map(w => Math.round(w.size))).size, 2);
});
