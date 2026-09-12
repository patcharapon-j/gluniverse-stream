/**
 * Framing math shared by the camera controller and its motion: where the view is, where a framing
 * would put it, and what the canvas can actually show.
 */

const NO_PADDING = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

export function gridSize() {
  return canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100;
}

export function getViewportSize() {
  const screen = canvas?.app?.renderer?.screen;
  return { width: screen?.width ?? window.innerWidth, height: screen?.height ?? window.innerHeight };
}

export function getCanvasView() {
  return {
    x: canvas?.stage?.pivot?.x ?? 0,
    y: canvas?.stage?.pivot?.y ?? 0,
    scale: canvas?.stage?.scale?.x ?? 1
  };
}

export function setCanvasView(view) {
  if (typeof canvas?.pan === "function") {
    canvas.pan({ x: view.x, y: view.y, scale: view.scale });
    return true;
  }
  if (canvas?.stage?.pivot && canvas?.stage?.scale) {
    const viewport = getViewportSize();
    canvas.stage.pivot.set(view.x, view.y);
    canvas.stage.scale.set(view.scale, view.scale);
    canvas.stage.position?.set?.(viewport.width / 2, viewport.height / 2);
    return true;
  }
  return false;
}

/**
 * Foundry constrains any view it is asked for. Clamping a destination the same way up front keeps the
 * module's idea of the camera in step with what is actually on screen, so a framing that would run off
 * the canvas lands as close as the canvas allows instead of chasing a point it can never reach.
 */
export function clampView(position) {
  const scale = clampScale(position.scale);
  const viewport = getViewportSize();
  const width = Number(canvas?.dimensions?.width) || 0;
  const height = Number(canvas?.dimensions?.height) || 0;
  let x = Number(position.x);
  let y = Number(position.y);
  if (!Number.isFinite(x)) x = 0;
  if (!Number.isFinite(y)) y = 0;
  if (width > 0) {
    const pad = 0.4 * (viewport.width / scale);
    x = clamp(x, -pad, width + pad);
  }
  if (height > 0) {
    const pad = 0.4 * (viewport.height / scale);
    y = clamp(y, -pad, height + pad);
  }
  return { x, y, scale };
}

export function clampScale(scale) {
  const value = Number(scale);
  const max = Number(CONFIG?.Canvas?.maxZoom) || 3;
  const viewport = getViewportSize();
  const width = Number(canvas?.dimensions?.width) || 0;
  const height = Number(canvas?.dimensions?.height) || 0;
  const ratio = Math.max(width / Math.max(1, viewport.width), height / Math.max(1, viewport.height), max);
  const min = 1 / ratio;
  if (!Number.isFinite(value) || value <= 0) return min;
  return clamp(value, min, max);
}

/**
 * Padding reserved on each side of the viewport, as a percentage of the viewport plus a number of grid
 * spaces. Framing fits inside what is left, which is what keeps overlays (chat, dialogs) clear of the
 * tokens the camera is following.
 */
export function getCameraPadding(settings, viewport = getViewportSize()) {
  const size = gridSize();
  return {
    top: sidePadding(settings.paddingPercentTop, viewport.height, settings.paddingGridSpacesTop, size),
    right: sidePadding(settings.paddingPercentRight, viewport.width, settings.paddingGridSpacesRight, size),
    bottom: sidePadding(settings.paddingPercentBottom, viewport.height, settings.paddingGridSpacesBottom, size),
    left: sidePadding(settings.paddingPercentLeft, viewport.width, settings.paddingGridSpacesLeft, size)
  };
}

export { NO_PADDING };

/** The scale at which `bounds` fits (or, with `fill`, covers) the padded viewport. */
export function fitScale(bounds, viewport, padding = NO_PADDING, fill = false) {
  const usableWidth = Math.max(100, viewport.width - padding.left - padding.right);
  const usableHeight = Math.max(100, viewport.height - padding.top - padding.bottom);
  const widthScale = usableWidth / Math.max(1, bounds.width);
  const heightScale = usableHeight / Math.max(1, bounds.height);
  return fill ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);
}

export function centeredPosition(bounds, scale, padding = NO_PADDING) {
  return {
    x: bounds.x + (bounds.width / 2) - ((padding.left - padding.right) / 2 / scale),
    y: bounds.y + (bounds.height / 2) - ((padding.top - padding.bottom) / 2 / scale),
    scale
  };
}

/**
 * The bounds a token is headed for. While a token animates Foundry writes its in-between position onto
 * the document, but `_source` already holds the committed destination, so the camera aims for where
 * the token will stop rather than chasing it along the way.
 */
export function tokenBounds(token) {
  const document = token?.document;
  if (!document) return null;
  const source = document._source ?? document;
  const size = gridSize();
  return {
    x: Number(source.x ?? document.x ?? 0),
    y: Number(source.y ?? document.y ?? 0),
    width: Number(source.width ?? document.width ?? 1) * size,
    height: Number(source.height ?? document.height ?? 1) * size
  };
}

export function unionBounds(bounds) {
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map(b => b.x));
  const minY = Math.min(...bounds.map(b => b.y));
  const maxX = Math.max(...bounds.map(b => b.x + b.width));
  const maxY = Math.max(...bounds.map(b => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function getSceneBounds() {
  const dimensions = canvas?.dimensions;
  const scene = canvas?.scene;
  if (!dimensions && !scene) return null;
  const rect = dimensions?.sceneRect;
  if (rect) return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  return {
    x: dimensions?.sceneX ?? 0,
    y: dimensions?.sceneY ?? 0,
    width: dimensions?.sceneWidth ?? scene?.width ?? dimensions?.width ?? 1,
    height: dimensions?.sceneHeight ?? scene?.height ?? dimensions?.height ?? 1
  };
}

/**
 * True when `bounds` sits inside the central `share` of the given view, measured on each axis. With a
 * share of 1 that is "anywhere on screen"; smaller shares describe a comfort zone around the center.
 */
export function isBoundsInView(bounds, view, share = 1) {
  if (!bounds || !view) return false;
  const viewport = getViewportSize();
  const halfWidth = (viewport.width / 2 / view.scale) * share;
  const halfHeight = (viewport.height / 2 / view.scale) * share;
  return bounds.x >= view.x - halfWidth
    && bounds.x + bounds.width <= view.x + halfWidth
    && bounds.y >= view.y - halfHeight
    && bounds.y + bounds.height <= view.y + halfHeight;
}

/**
 * True while this client is mid-interaction on the canvas (dragging a token, drawing a ruler, placing a
 * preview). The camera stays off the canvas transform until that finishes.
 */
export function isCanvasInteractionBusy() {
  try {
    if (canvas?.activeLayer?.preview?.children?.length) return true;
    if (canvas?.tokens?.preview?.children?.length) return true;
    if (canvas?.controls?.ruler?.active) return true;
    const dragState = interactionDragState();
    return (canvas?.tokens?.placeables ?? []).some(token => Number(token?.mouseInteractionManager?.state) >= dragState);
  } catch (_error) {
    return false;
  }
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function interactionDragState() {
  const states = foundry?.canvas?.interaction?.MouseInteractionManager?.INTERACTION_STATES
    ?? globalThis.MouseInteractionManager?.INTERACTION_STATES;
  return Number(states?.DRAG) || 3;
}

function sidePadding(percent, viewportSize, gridSpaces, size) {
  return (Math.max(0, Number(percent) || 0) / 100 * viewportSize) + (Math.max(0, Number(gridSpaces) || 0) * size);
}
