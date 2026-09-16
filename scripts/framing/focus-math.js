/**
 * Portrait framing geometry. Pure: no DOM, no Foundry.
 *
 * A focus is the part of an image the roll card shows, as `{x, y, w}`: the crop's left edge, top edge
 * and width, all in units of the image's own width. The crop's height follows from the card's art
 * aspect, so one focus fits every card size.
 */

/** Width : height of the roll card's art area (8.2u x 4.4u). */
export const ART_ASPECT = 8.2 / 4.4;

/** Zoomed detection windows, as fractions of the image's short side. */
export const TILE_FRACTIONS = [0.6, 0.4];
/** Windows only cover this much of the image from the top: faces in character art sit high. */
export const TILE_COVERAGE = 0.75;

/** The detection windows for an image, each overlapping its neighbours by half. */
export function tileWindows(width, height) {
  const windows = [];
  for (const fraction of TILE_FRACTIONS) {
    const size = Math.min(width, height) * fraction;
    const step = size / 2;
    for (let y = 0; y + size <= height * TILE_COVERAGE + 1; y += step) {
      for (let x = 0; x + size <= width + 1; x += step) windows.push({ x, y, size });
    }
  }
  return windows;
}

/**
 * Picks the face to frame from every detection across the whole image and its windows.
 * Overlapping hits merge into one face with a vote per window that saw it. A face needs a confident
 * score, or several windows agreeing on a fair one, and in tall art it must sit in the top half:
 * low hits there are nearly always armour, hands or chest plates.
 *
 * @param {{score: number, box: {x: number, y: number, width: number, height: number}}[]} detections  image pixels
 * @returns {{score: number, votes: number, box: object}|null}
 */
export function pickFace(detections, width, height) {
  const merged = [];
  for (const d of [...detections].sort((a, b) => b.score - a.score)) {
    const cx = d.box.x + d.box.width / 2;
    const cy = d.box.y + d.box.height / 2;
    const same = merged.find(m => Math.abs(m.cx - cx) < m.box.width * 0.5 && Math.abs(m.cy - cy) < m.box.height * 0.5);
    if (same) same.votes++;
    else merged.push({ score: d.score, box: d.box, cx, cy, votes: 1 });
  }
  const tall = height > width * 1.15;
  const floor = height * (tall ? 0.5 : 0.75);
  const accepted = merged.filter(m => (m.score >= 0.75 || (m.votes >= 3 && m.score >= 0.45)) && m.cy <= floor);
  accepted.sort((a, b) => b.score + 0.08 * (b.votes - 1) - (a.score + 0.08 * (a.votes - 1)));
  const best = accepted[0];
  return best ? { score: best.score, votes: best.votes, box: best.box } : null;
}

/** A crop that frames a face with the shoulders below it, the face a little left of and above centre. */
export function cropForFace(box, width, height, aspect = ART_ASPECT) {
  let h = Math.min(height, box.height * 3.2);
  let w = h * aspect;
  if (w > width) {
    w = width;
    h = w / aspect;
  }
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return clampCrop({ x: cx - w * 0.4, y: cy - h * 0.42, width: w, height: h }, width, height);
}

/** The card's framing when nothing better is known: full width, near the top. */
export function defaultCrop(width, height, aspect = ART_ASPECT) {
  let w = width;
  let h = w / aspect;
  if (h > height) {
    h = height;
    w = h * aspect;
  }
  return { x: (width - w) / 2, y: (height - h) * 0.14, width: w, height: h };
}

export function clampCrop(crop, width, height) {
  const w = Math.min(crop.width, width);
  const h = Math.min(crop.height, height);
  return {
    x: Math.max(0, Math.min(width - w, crop.x)),
    y: Math.max(0, Math.min(height - h, crop.y)),
    width: w,
    height: h
  };
}

/** Pixel crop -> focus. */
export function toFocus(crop, width) {
  return { x: round(crop.x / width), y: round(crop.y / width), w: round(crop.width / width) };
}

/** Focus -> pixel crop, clamped to the image. */
export function fromFocus(focus, width, height, aspect = ART_ASPECT) {
  const w = focus.w * width;
  return clampCrop({ x: focus.x * width, y: focus.y * width, width: w, height: w / aspect }, width, height);
}

export function isFocus(value) {
  return !!value && [value.x, value.y, value.w].every(Number.isFinite) && value.w > 0 && value.w <= 1.0001;
}

/**
 * How to place the `<img>` inside the art box for a focus, as multiples of the box width:
 * the image is `scale` box-widths wide and shifted by `left` and `top` box-widths.
 */
export function placement(focus) {
  return { scale: 1 / focus.w, left: -focus.x / focus.w, top: -focus.y / focus.w };
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
