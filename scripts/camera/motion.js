import { animate, eases, onCanvasFrame } from "../motion/engine.js";
import { clamp, clampScale, getCanvasView, getViewportSize, gridSize, isCanvasInteractionBusy, setCanvasView } from "./framing.js";

const MIN_GLIDE_MS = 350;
const MAX_GLIDE_MS = 2500;
const MIN_FLIGHT_MS = 1000;
const MAX_FLIGHT_MS = 3600;
/** Share of a flight spent covering ground; the rest is the zoom-out before it and the zoom-in after. */
const FLIGHT_TRAVEL_SHARE = 0.6;
/** Time a zoom-only change takes per e-fold (about 2.7x) of scale. */
const ZOOM_MS_PER_E_FOLD = 900;
/** A flight always zooms out at least this share of the configured travel zoom-out, so it reads as one. */
const MIN_FLIGHT_DEPTH_SHARE = 0.5;
const SETTLE_DISTANCE = 0.5;
const SETTLE_LOG_SCALE = 0.002;
const INTERACTION_HOLD_MS = 8000;
/**
 * Overlapping zoom-outs combine as a p-norm rather than a sum: a single flight dips exactly as deep as
 * asked, and two flights overlapping at full depth only dip about 9% deeper, so a retarget mid-flight
 * stays zoomed out instead of zooming out twice.
 */
const DEPTH_NORM = 8;

/**
 * A glide eases position and zoom together. A flight zooms out, crosses while zoomed out, and zooms
 * back in; the three phases overlap so the whole thing reads as one continuous arc. `move` maps the
 * layer's progress to how much of its offset has been covered, `depth` to how zoomed out it is.
 */
const GLIDE = {
  move: progress => eases.inOutSine(progress),
  depth: () => 0
};
const FLIGHT = {
  move: progress => eases.inOutCubic(window01(progress, 0.12, 0.88)),
  depth: progress => eases.inOutSine(window01(progress, 0, 0.4)) * (1 - eases.inOutSine(window01(progress, 0.58, 1)))
};

/**
 * Drives the canvas view with anime.js. Every move is a layer: anime.js animates the layer's clock, and
 * each canvas frame the view is composed from the newest goal plus what is left of every layer's offset
 * from the goal before it. A new destination mid-move therefore adds a layer instead of restarting: the
 * older layers keep easing out at their own pace underneath it, so position, zoom and velocity all stay
 * continuous however often the target changes.
 */
export class CameraMotion {
  #layers = [];
  #goal = null;
  #stopListening = null;
  #heldSince = 0;
  #promise = null;
  #resolve = null;

  get moving() {
    return this.#layers.length > 0;
  }

  /** Jump straight to a view with no animation. */
  snap(view) {
    this.stop();
    this.#goal = toLogView(view);
    return setCanvasView(view);
  }

  /**
   * Move toward a view. `speed` is in grid squares per second. With `flight`, the move zooms out by up to
   * `travelZoomOut`, scaled by how far it has to go, and zooms back in on arrival.
   */
  moveTo(view, { speed = 12, travelZoomOut = 1, flight = false } = {}) {
    const goal = toLogView(view);
    if (this.moving) {
      if (isSameView(goal, this.#goal)) return this.#promise;
    } else if (isSameView(goal, toLogView(getCanvasView()))) {
      this.#goal = goal;
      return Promise.resolve(true);
    }

    const from = this.moving ? this.#goal : toLogView(getCanvasView());
    const current = this.moving ? this.#composeView() : from;
    const distance = Math.hypot(goal.x - current.x, goal.y - current.y);
    const zoomMs = Math.abs(goal.z - current.z) * ZOOM_MS_PER_E_FOLD;
    const travelMs = (distance / gridSize()) / Math.max(0.1, Number(speed) || 0) * 1000;
    const depth = flight ? flightDepth(distance, current, travelZoomOut) : 0;
    const shape = depth > 0 ? FLIGHT : GLIDE;
    const duration = depth > 0
      ? clamp(Math.max(travelMs / FLIGHT_TRAVEL_SHARE, zoomMs), MIN_FLIGHT_MS, MAX_FLIGHT_MS)
      : clamp(Math.max(travelMs, zoomMs), MIN_GLIDE_MS, MAX_GLIDE_MS);

    const layer = {
      offset: { x: from.x - goal.x, y: from.y - goal.y, z: from.z - goal.z },
      shape,
      depth,
      duration,
      clock: { elapsed: 0 },
      animation: null
    };
    layer.animation = animate(layer.clock, {
      elapsed: duration,
      duration,
      ease: "linear",
      onComplete: () => this.#retire(layer)
    });
    if (this.#heldSince) layer.animation.pause();

    this.#goal = goal;
    this.#layers.push(layer);
    this.#stopListening ??= onCanvasFrame(() => this.#onFrame());
    this.#promise ??= new Promise(resolve => {
      this.#resolve = resolve;
    });
    return this.#promise;
  }

  stop() {
    for (const layer of this.#layers) layer.animation?.cancel();
    this.#layers = [];
    this.#goal = null;
    this.#finish(false);
  }

  #onFrame() {
    if (!canvas?.ready) return this.stop();
    if (isCanvasInteractionBusy()) {
      // Hold still while this client drags a token or measures, but never wait forever on an
      // interaction state that does not clear.
      if (!this.#heldSince) {
        this.#heldSince = performance.now();
        for (const layer of this.#layers) layer.animation?.pause();
      } else if (performance.now() - this.#heldSince > INTERACTION_HOLD_MS) {
        this.stop();
      }
      return;
    }
    if (this.#heldSince) {
      this.#heldSince = 0;
      for (const layer of this.#layers) layer.animation?.resume();
    }
    setCanvasView(fromLogView(this.#composeView()));
  }

  #composeView() {
    const goal = this.#goal;
    let { x, y, z } = goal;
    let depth = 0;
    for (const layer of this.#layers) {
      const progress = clamp(layer.clock.elapsed / layer.duration, 0, 1);
      const remaining = 1 - layer.shape.move(progress);
      x += layer.offset.x * remaining;
      y += layer.offset.y * remaining;
      z += layer.offset.z * remaining;
      if (layer.depth > 0) depth += (layer.depth * layer.shape.depth(progress)) ** DEPTH_NORM;
    }
    return { x, y, z: z - (depth ** (1 / DEPTH_NORM)) };
  }

  #retire(layer) {
    this.#layers = this.#layers.filter(entry => entry !== layer);
    if (this.#layers.length) return;
    if (canvas?.ready && this.#goal) setCanvasView(fromLogView(this.#goal));
    this.#finish(true);
  }

  #finish(completed) {
    this.#stopListening?.();
    this.#stopListening = null;
    this.#heldSince = 0;
    const resolve = this.#resolve;
    this.#promise = null;
    this.#resolve = null;
    resolve?.(completed);
  }
}

/**
 * How far (in log-scale) a flight zooms out. Crossing half a screen or less uses half the configured
 * travel zoom-out; crossing two screens or more uses all of it.
 */
function flightDepth(distance, current, travelZoomOut) {
  const factor = Number(travelZoomOut);
  if (!(factor > 1)) return 0;
  const viewport = getViewportSize();
  const span = Math.max(viewport.width, viewport.height) / Math.exp(current.z);
  const reach = eases.inOutSine(window01(distance / Math.max(1, span), 0.5, 2));
  return Math.log(factor) * (MIN_FLIGHT_DEPTH_SHARE + ((1 - MIN_FLIGHT_DEPTH_SHARE) * reach));
}

/** Zoom is animated in log space so zooming in and out feel equally fast. */
function toLogView(view) {
  return { x: Number(view.x) || 0, y: Number(view.y) || 0, z: Math.log(Math.max(0.0001, Number(view.scale) || 1)) };
}

function fromLogView(view) {
  return { x: view.x, y: view.y, scale: clampScale(Math.exp(view.z)) };
}

function isSameView(a, b) {
  if (!a || !b) return false;
  return Math.hypot(a.x - b.x, a.y - b.y) <= SETTLE_DISTANCE && Math.abs(a.z - b.z) <= SETTLE_LOG_SCALE;
}

function window01(value, start, end) {
  return clamp((value - start) / (end - start), 0, 1);
}
