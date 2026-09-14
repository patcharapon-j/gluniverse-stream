import { animate, createTimeline, createTimer, eases, engine, remove } from "../vendor/anime.esm.min.js";
import { MODULE_ID } from "../constants.js";

export { animate, createTimeline, createTimer, eases, remove };

/**
 * Canvas-bound work runs just after Foundry's token animations advance (`LOW + 1`) and just before the
 * canvas renders (`LOW`), so anything that reads a token's animated position, or moves the stage,
 * lands in the same frame the canvas draws.
 */
const CANVAS_TICK_PRIORITY = (globalThis.PIXI?.UPDATE_PRIORITY?.LOW ?? -25) + 0.5;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

const frameListeners = new Set();
let attachedTicker = null;

/**
 * Every animation in the module runs on this one anime.js engine, which is the module's own copy and
 * never Foundry's. While a canvas exists the engine is stepped from the canvas ticker instead of its
 * own requestAnimationFrame loop, so camera moves and canvas effects cannot drift a frame out of step
 * with the canvas render. Without a canvas the engine runs its default loop, which is all the DOM
 * overlays need.
 */
export function registerMotionEngine() {
  Hooks.on("canvasReady", attachToCanvasTicker);
  Hooks.on("canvasTearDown", detachFromCanvasTicker);
  if (globalThis.canvas?.ready) attachToCanvasTicker();
}

/**
 * Runs a listener once per canvas frame, after the engine has advanced. Listeners only run while the
 * engine is attached to a canvas, which is the only time canvas-bound work has anything to draw.
 * Returns a function that removes the listener.
 */
export function onCanvasFrame(listener) {
  frameListeners.add(listener);
  return () => frameListeners.delete(listener);
}

/**
 * True when this client asked for less motion, through the OS/browser reduced-motion preference or
 * Foundry's photosensitive mode. Overlays and canvas effects switch to calm variants; the stream camera
 * deliberately does not consult this.
 */
export function prefersCalmMotion() {
  if (globalThis.matchMedia?.(REDUCED_MOTION_QUERY)?.matches) return true;
  try {
    return Boolean(game.settings.get("core", "photosensitiveMode"));
  } catch (_error) {
    return false;
  }
}

function attachToCanvasTicker() {
  const ticker = globalThis.canvas?.app?.ticker;
  if (!ticker || ticker === attachedTicker) return;
  detachFromCanvasTicker();
  engine.useDefaultMainLoop = false;
  if (engine.reqId) {
    // Stop the default loop so the engine is not stepped twice per frame. `pause` is the only public
    // way to cancel that loop; clearing `paused` again keeps visibility handling behaving as if the
    // engine had never been paused.
    engine.pause();
    engine.paused = false;
  }
  ticker.add(stepEngine, null, CANVAS_TICK_PRIORITY);
  attachedTicker = ticker;
}

function detachFromCanvasTicker() {
  if (!attachedTicker) return;
  attachedTicker.remove(stepEngine, null);
  attachedTicker = null;
  engine.useDefaultMainLoop = true;
  engine.wake();
}

function stepEngine() {
  engine.update();
  for (const listener of frameListeners) {
    try {
      listener();
    } catch (error) {
      console.error(`${MODULE_ID} | Canvas frame listener failed`, error);
    }
  }
}
