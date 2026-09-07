import { getActiveSceneCombat, getCombatants } from "./combat-utils.js";
import { CAMERA_MODES, MODULE_ID, SCENE_VIEW_MODES, STREAM_COMMANDS } from "./constants.js";
import { getCameraSettings } from "./settings.js";
import { sendStreamCommand } from "./socket.js";

const MIN_SMOOTH_TIME = 0.04;
const MAX_FRAME_SECONDS = 1 / 20;
/**
 * A critically damped move is ~96% complete after 5 time constants, so a configured duration maps
 * to a smoothing time of about four tenths of it. That keeps the configured "follow ms" meaning
 * roughly "time to arrive" while the motion itself stays continuous and retargetable.
 */
const SMOOTH_TIME_RATIO = 0.4;
const SETTLE_DISTANCE = 1;
const SETTLE_SCALE = 0.002;
const SETTLE_SPEED = 4;
const SETTLE_TRAVEL = 0.02;
/** Ignore pull-back for moves shorter than this fraction of the visible span, so short steps do not breathe the zoom. */
const TRAVEL_DEADZONE = 0.12;
const REFRAME_DEBOUNCE_MS = 100;
const INTERACTION_HOLD_MS = 8000;
const MAX_INTERACTION_RETRIES = 120;

export class CameraController {
  constructor(streamMode, tokenTracking) {
    this.streamMode = streamMode;
    this.tokenTracking = tokenTracking;
    this.tokenDestinations = new Map();
    this.queued = null;
    this.queuedFrame = null;
    this.queuedTimeout = null;
    this.target = null;
    this.motion = null;
    this.motionPromise = null;
    this.motionResolve = null;
    this.busyRetries = 0;
  }

  registerHooks() {
    Hooks.on("canvasReady", () => {
      this.stopMotion();
      this.tokenDestinations.clear();
      this.scheduleReframe({ animate: false, force: true });
    });
    /**
     * Camera work never runs from `preUpdateToken`. That hook is part of the document update
     * workflow that Foundry's movement pipeline drives, and mutating the canvas transform from
     * inside it fights the live drag/ruler interaction that issued the move, which can cancel the
     * movement outright. Reframing therefore only reacts to committed updates, always off the hook's
     * own call stack, so the module can never stop a token from moving.
     */
    Hooks.on("updateToken", (doc, changes) => {
      if (!hasTokenFrameChange(changes)) return;
      this.cacheTokenDestination(doc, changes);
      this.scheduleReframe({ immediate: hasTokenPositionChange(changes) });
    });
    Hooks.on("updateTokenDocument", (doc, changes) => {
      if (!hasTokenFrameChange(changes)) return;
      this.cacheTokenDestination(doc, changes);
      this.scheduleReframe({ immediate: hasTokenPositionChange(changes) });
    });
    Hooks.on("createToken", () => this.scheduleReframe());
    Hooks.on("deleteToken", doc => {
      if (doc?.id) this.tokenDestinations.delete(doc.id);
      this.scheduleReframe();
    });
    Hooks.on("targetToken", () => this.scheduleReframe({ immediate: true }));
    Hooks.on("combatStart", () => this.scheduleReframe());
    Hooks.on("combatRound", () => this.scheduleReframe());
    Hooks.on("combatTurn", () => this.scheduleReframe());
    Hooks.on("combatTurnChange", () => this.scheduleReframe());
    Hooks.on("createCombat", () => this.scheduleReframe());
    Hooks.on("updateCombat", () => this.scheduleReframe());
    Hooks.on("deleteCombat", () => this.scheduleReframe());
    Hooks.on("updateCombatant", () => this.scheduleReframe());
    Hooks.on("createCombatant", () => this.scheduleReframe());
    Hooks.on("deleteCombatant", () => this.scheduleReframe());
    Hooks.on(`${MODULE_ID}.trackedTokensChanged`, () => this.scheduleReframe());
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (key === "cameraSettings") this.scheduleReframe({ force: true });
    });
    Hooks.on("updateScene", (scene, changes) => {
      if (scene.id === canvas?.scene?.id && (foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`) || "width" in changes || "height" in changes || "background" in changes)) this.scheduleReframe({ force: true });
    });
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => {
      if (active) this.scheduleReframe({ animate: false, force: true });
      else this.stopMotion();
    });
  }

  requestReframe(payload = {}) {
    sendStreamCommand(STREAM_COMMANDS.reframe, { force: true, explicit: true, ...payload });
  }

  /**
   * Reframes are always queued and run on a later animation frame. Nothing here touches the canvas
   * synchronously from a Foundry hook, so a reframe can never interleave with a document update or
   * a canvas interaction that is still in progress.
   */
  scheduleReframe(options = {}) {
    if (!this.streamMode.active) return;
    return this.#enqueueReframe(options);
  }

  #enqueueReframe(options) {
    this.queued = mergeReframeOptions(this.queued, options);
    if (this.queuedFrame || this.queuedTimeout) {
      if (!this.queued.immediate && !this.queued.force) return;
      window.clearTimeout(this.queuedTimeout);
      this.queuedTimeout = null;
      if (this.queuedFrame) return;
    }
    if (this.queued.immediate || this.queued.force) return this.#queueFrame();
    this.queuedTimeout = window.setTimeout(() => {
      this.queuedTimeout = null;
      this.#queueFrame();
    }, REFRAME_DEBOUNCE_MS);
  }

  #queueFrame() {
    if (this.queuedFrame) return;
    this.queuedFrame = requestAnimationFrame(() => {
      this.queuedFrame = null;
      const options = this.queued ?? {};
      this.queued = null;
      this.reframe(options);
    });
  }

  async reframe({ animate = true, force = false, explicit = false } = {}) {
    if (!canvas?.ready || (!this.streamMode.active && !force)) return false;
    if (isCanvasInteractionBusy() && this.busyRetries < MAX_INTERACTION_RETRIES) {
      // A drag, ruler, or token placement is live on this client. Retry on the next frame instead of
      // moving the canvas out from under it, but give up waiting rather than stall the camera if an
      // interaction state never clears.
      this.busyRetries += 1;
      this.#enqueueReframe({ animate, force, explicit, immediate: true });
      return false;
    }
    this.busyRetries = 0;
    const settings = getCameraSettings();
    const mode = this.getEffectiveMode(settings);
    const reapply = force || explicit;
    if (mode === CAMERA_MODES.manual) return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    if (mode === CAMERA_MODES.scene) return this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply });

    if (mode === CAMERA_MODES.spotlight) {
      const spotlightToken = this.getSpotlightToken(settings);
      if (spotlightToken) return this.frameSpotlight(spotlightToken, { animate, force: reapply });
      const fallback = this.getTokensForMode(CAMERA_MODES.combatants, settings);
      if (fallback.length) return this.frameTokenBounds(fallback, { animate, force: reapply });
      if (!getActiveSceneCombat()) return this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply });
      return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    }

    const tokens = this.getTokensForMode(mode, settings);
    if (!tokens.length) return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    return this.frameTokenBounds(tokens, { animate, force: reapply });
  }

  getEffectiveMode(settings = getCameraSettings()) {
    return getActiveSceneCombat() ? settings.combatMode : settings.outOfCombatMode;
  }

  /**
   * Tokens to frame for a mode, plus whatever those tokens are currently targeting, so an attack
   * across the map keeps both ends of the action in the shot.
   */
  getTokensForMode(mode, settings = getCameraSettings()) {
    const tokens = this.getModeTokens(mode, settings);
    if (!tokens.length) return tokens;
    return unionTokens(tokens, this.getTargetTokens(tokens, settings));
  }

  getModeTokens(mode, settings) {
    switch (mode) {
      case CAMERA_MODES.party:
        return unionTokens(visibleTokens().filter(isPartyToken), this.getVisibleTrackedTokens());
      case CAMERA_MODES.trackedToken:
        return this.getVisibleTrackedTokens();
      case CAMERA_MODES.combatants: {
        const combat = getActiveSceneCombat();
        if (!combat) return [];
        const seen = new Set();
        const combatantTokens = getCombatants(combat).reduce((tokens, combatant) => {
          if (settings.excludeDefeated !== false && combatant.defeated) return tokens;
          const token = getCombatantToken(combatant);
          const id = token?.document?.id;
          if (id && seen.has(id)) return tokens;
          if (isVisibleToken(token)) tokens.push(token);
          if (id) seen.add(id);
          return tokens;
        }, []);
        return unionTokens(combatantTokens, this.getVisibleTrackedTokens());
      }
      case CAMERA_MODES.activeTurn: {
        const combat = getActiveSceneCombat();
        if (!combat) return [];
        const activeTokens = [];
        const combatant = getActiveCombatant(combat);
        if (combatant && !(settings.excludeDefeated !== false && combatant.defeated)) {
          const token = getCombatantToken(combatant);
          if (isVisibleToken(token)) activeTokens.push(token);
        }
        return unionTokens(activeTokens, this.getVisibleTrackedTokens());
      }
      case CAMERA_MODES.spotlight: {
        const token = this.getSpotlightToken(settings);
        return token ? [token] : [];
      }
      default:
        return [];
    }
  }

  /**
   * The spotlight target is only ever the token of the combatant whose turn it is, and only while a
   * combat is running on the canvas scene. Tracked tokens are deliberately not unioned in: spotlight
   * is a single-token framing, so adding other tokens would pull the camera off the active token.
   * Tokens the active token is targeting are the one exception, handled in `frameSpotlight`.
   */
  getSpotlightToken(settings = getCameraSettings()) {
    const combat = getActiveSceneCombat();
    if (!combat) return null;
    const combatant = getActiveCombatant(combat);
    if (!combatant) return null;
    if (settings.excludeDefeated !== false && combatant.defeated) return null;
    const token = getCombatantToken(combatant);
    if (!isVisibleToken(token)) return null;
    if (settings.spotlightPlayersOnly && !isPartyToken(token)) return null;
    return token;
  }

  getVisibleTrackedTokens() {
    return this.tokenTracking.getTrackedTokens().filter(isVisibleToken);
  }

  /**
   * Tokens the given tokens are currently targeting, so an attack keeps both ends of the action in
   * frame. Foundry stores targets per user, so a token's targets are the targets of the users who
   * control it: its actor's player owners, or the active GMs for tokens no player owns.
   */
  getTargetTokens(sources, settings = getCameraSettings()) {
    if (settings.includeTargets === false) return [];
    const sourceIds = new Set(sources.map(token => token?.document?.id).filter(Boolean));
    const targets = [];
    const seen = new Set();
    for (const source of sources) {
      for (const target of targetsOfToken(source)) {
        const id = target?.document?.id;
        if (!id || seen.has(id) || sourceIds.has(id)) continue;
        if (!isVisibleToken(target)) continue;
        seen.add(id);
        targets.push(target);
      }
    }
    return targets;
  }

  async frameScene({ animate = true, viewMode = SCENE_VIEW_MODES.fitBackground, force = false } = {}) {
    const bounds = getSceneBounds();
    if (!bounds) return false;
    return this.applyBounds(bounds, {
      animate,
      fill: viewMode === SCENE_VIEW_MODES.fillBackground,
      clampZoom: false,
      usePadding: false,
      dynamicZoom: false,
      force
    });
  }

  async frameTokenBounds(tokens, { animate = true, force = false } = {}) {
    const bounds = unionBounds(tokens.map(token => this.boundsFor(token)).filter(Boolean));
    if (!bounds) return false;
    return this.applyBounds(bounds, { animate, fill: false, clampZoom: true, dynamicZoom: true, force });
  }

  boundsFor(token) {
    return tokenBounds(token, this.tokenDestinations.get(token?.document?.id));
  }

  async applyBounds(bounds, { animate = true, fill = false, clampZoom = true, usePadding = true, dynamicZoom = true, force = false } = {}) {
    const settings = getCameraSettings();
    const viewport = getViewportSize();
    const padding = usePadding ? getCameraPadding(settings, viewport) : { top: 0, right: 0, bottom: 0, left: 0 };
    const usableWidth = Math.max(100, viewport.width - padding.left - padding.right);
    const usableHeight = Math.max(100, viewport.height - padding.top - padding.bottom);
    const widthScale = usableWidth / Math.max(1, bounds.width);
    const heightScale = usableHeight / Math.max(1, bounds.height);
    let scale = fill ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);

    if (clampZoom) {
      const min = Number(settings.minZoom) || 0.01;
      const max = Math.max(min, Number(settings.maxZoom) || min);
      scale = clamp(scale, min, max);
    }

    const position = {
      ...centeredPosition(bounds, scale, padding),
      duration: animate ? animationDuration(settings) : 0
    };
    return this.applyPosition(position, { force, dynamicZoom, settings });
  }

  /**
   * Spotlight framing normally ignores fit/fill bounds math entirely: the active token is centered
   * and the canvas is set to the configured spotlight zoom, so the operator gets the same framing
   * distance on every turn. When the active token is targeting something, the framing widens just
   * far enough to hold the token and its targets, never zooming in past the spotlight zoom and
   * never past `minZoom` on the way out.
   */
  async frameSpotlight(token, { animate = true, force = false } = {}) {
    const settings = getCameraSettings();
    const focus = [token, ...this.getTargetTokens([token], settings)];
    const boundsList = focus.map(entry => this.boundsFor(entry)).filter(Boolean);
    const bounds = unionBounds(boundsList);
    if (!bounds) return false;

    const viewport = getViewportSize();
    const padding = getCameraPadding(settings, viewport);
    let scale = spotlightZoom(settings);
    if (boundsList.length > 1) {
      const usableWidth = Math.max(100, viewport.width - padding.left - padding.right);
      const usableHeight = Math.max(100, viewport.height - padding.top - padding.bottom);
      const fit = Math.min(usableWidth / Math.max(1, bounds.width), usableHeight / Math.max(1, bounds.height));
      scale = Math.max(Math.min(scale, fit), Number(settings.minZoom) || 0.01);
    }

    const position = {
      ...centeredPosition(bounds, scale, padding),
      duration: animate ? animationDuration(settings) : 0
    };
    return this.applyPosition(position, { force, dynamicZoom: true, settings });
  }

  /**
   * Hands a new destination to the motion loop. Retargeting mid-flight is normal and cheap: the
   * loop keeps its current velocity, so a turn change during a pan bends the existing move instead
   * of restarting it. The destination is clamped to what the canvas can actually show first, so an
   * unreachable framing simply lands as close as the canvas allows.
   */
  applyPosition(position, { force = false, dynamicZoom = false, settings = getCameraSettings() } = {}) {
    try {
      const duration = Math.max(0, Number(position.duration) || 0);
      const target = {
        ...clampView(position),
        dynamicZoom: dynamicZoom && travelZoomOutFactor(settings) > 1,
        zoomOutFactor: travelZoomOutFactor(settings),
        smoothTime: (duration / 1000) * SMOOTH_TIME_RATIO,
        travelSmoothTime: travelSmoothTime(settings, duration),
        zoomSmoothTime: zoomSmoothTime(settings, duration)
      };
      if (duration <= 0) {
        this.stopMotion();
        this.target = target;
        return setCanvasView(target);
      }
      this.target = target;
      if (this.motion) return this.motionPromise ?? true;
      if (!force && isViewSettled(getCanvasView(), target)) return true;
      return this.startMotion();
    } catch (error) {
      console.warn(`${MODULE_ID} | Camera reframe failed`, error);
      return false;
    }
  }

  startMotion() {
    const view = getCanvasView();
    this.motion = {
      view: { ...view },
      velocity: { x: 0, y: 0, zoom: 0, travel: 0 },
      travel: 0,
      last: performance.now(),
      heldSince: 0,
      frame: null
    };
    this.motionPromise = new Promise(resolve => {
      this.motionResolve = resolve;
    });
    const step = now => {
      const motion = this.motion;
      if (!motion) return;
      const delta = clamp((now - motion.last) / 1000, 0, MAX_FRAME_SECONDS);
      motion.last = now;
      let settled = true;
      try {
        settled = this.advanceMotion(delta, now);
      } catch (error) {
        console.warn(`${MODULE_ID} | Camera motion failed`, error);
        settled = true;
      }
      if (settled) return this.finishMotion();
      motion.frame = requestAnimationFrame(step);
    };
    this.motion.frame = requestAnimationFrame(step);
    return this.motionPromise;
  }

  advanceMotion(delta, now) {
    const motion = this.motion;
    const target = this.target;
    if (!motion || !target) return true;
    if (!canvas?.ready) return true;
    if (isCanvasInteractionBusy()) {
      // Hold the camera still while the local user is dragging on the canvas, but never hold
      // forever if an interaction state gets stuck.
      if (!motion.heldSince) motion.heldSince = now;
      motion.view = { ...getCanvasView() };
      motion.velocity = { x: 0, y: 0, zoom: 0, travel: 0 };
      motion.travel = 0;
      if ((now - motion.heldSince) <= INTERACTION_HOLD_MS) return false;
      this.target = null;
      return true;
    }
    motion.heldSince = 0;

    const viewport = getViewportSize();
    const span = Math.max(1, Math.max(viewport.width, viewport.height) / Math.max(0.01, motion.view.scale));
    const distance = Math.hypot(target.x - motion.view.x, target.y - motion.view.y);
    const desiredTravel = target.dynamicZoom ? clamp(((distance / span) - TRAVEL_DEADZONE) / (1 - TRAVEL_DEADZONE), 0, 1) : 0;
    motion.travel = clamp(smoothDamp(motion.travel, desiredTravel, motion.velocity, "travel", target.travelSmoothTime, delta), 0, 1);

    const goalScale = clampScale(target.scale / (1 + ((target.zoomOutFactor - 1) * motion.travel)));
    motion.view.x = smoothDamp(motion.view.x, target.x, motion.velocity, "x", target.smoothTime, delta);
    motion.view.y = smoothDamp(motion.view.y, target.y, motion.velocity, "y", target.smoothTime, delta);
    motion.view.scale = Math.exp(smoothDamp(Math.log(motion.view.scale), Math.log(goalScale), motion.velocity, "zoom", target.zoomSmoothTime, delta));

    setCanvasView(motion.view);
    if (motion.travel > SETTLE_TRAVEL) return false;
    if (Math.hypot(motion.velocity.x, motion.velocity.y) > SETTLE_SPEED) return false;
    return isViewSettled(motion.view, target);
  }

  finishMotion() {
    const resolve = this.motionResolve;
    if (this.motion?.frame) cancelAnimationFrame(this.motion.frame);
    this.motion = null;
    this.motionPromise = null;
    this.motionResolve = null;
    if (this.target && canvas?.ready) setCanvasView(this.target);
    if (resolve) resolve(true);
    return true;
  }

  stopMotion() {
    const resolve = this.motionResolve;
    if (this.motion?.frame) cancelAnimationFrame(this.motion.frame);
    this.motion = null;
    this.motionPromise = null;
    this.motionResolve = null;
    this.target = null;
    if (resolve) resolve(false);
  }

  cacheTokenDestination(doc, changes) {
    const id = doc?.id;
    if (!id) return;
    this.tokenDestinations.set(id, {
      x: "x" in changes ? changes.x : doc.x,
      y: "y" in changes ? changes.y : doc.y,
      width: "width" in changes ? changes.width : doc.width,
      height: "height" in changes ? changes.height : doc.height
    });
  }
}

function mergeReframeOptions(current, options) {
  const merged = { ...(current ?? {}), ...options };
  if (current) {
    merged.force = Boolean(current.force || options.force);
    merged.explicit = Boolean(current.explicit || options.explicit);
    merged.immediate = Boolean(current.immediate || options.immediate);
    merged.animate = current.animate === false || options.animate === false ? false : merged.animate;
  }
  return merged;
}

function centeredPosition(bounds, scale, padding) {
  return {
    x: bounds.x + (bounds.width / 2) - ((padding.left - padding.right) / 2 / scale),
    y: bounds.y + (bounds.height / 2) - ((padding.top - padding.bottom) / 2 / scale),
    scale
  };
}

function animationDuration(settings) {
  return Math.max(0, Number(settings.animationDurationMs) || 0);
}

function spotlightZoom(settings) {
  const zoom = Number(settings.spotlightZoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

/**
 * How far the camera pulls back while it travels. Kept under the legacy `spotlightPullback*` keys,
 * but the travel zoom-out now applies to every token-following mode, not just spotlight.
 */
function travelZoomOutFactor(settings) {
  if (settings.spotlightPullback === false) return 1;
  const factor = Number(settings.spotlightPullbackFactor);
  return Number.isFinite(factor) && factor > 1 ? factor : 1;
}

function travelSmoothTime(settings, duration) {
  const configured = Math.max(0, Number(settings.spotlightPullbackDurationMs) || 0);
  return ((configured > 0 ? configured : duration / 2) / 1000) * SMOOTH_TIME_RATIO;
}

function zoomSmoothTime(settings, duration) {
  const pan = (duration / 1000) * SMOOTH_TIME_RATIO;
  const travel = travelSmoothTime(settings, duration);
  return Math.max(MIN_SMOOTH_TIME, Math.min(pan, Math.max(travel, pan / 2)));
}

/**
 * Critically damped smoothing (no overshoot) that keeps its velocity between frames, which is what
 * makes a mid-flight retarget bend the current move instead of snapping to a new one.
 */
function smoothDamp(current, target, velocities, key, smoothTime, delta) {
  if (!(delta > 0)) return current;
  const time = Math.max(MIN_SMOOTH_TIME, Number(smoothTime) || 0);
  const omega = 2 / time;
  const x = omega * delta;
  const decay = 1 / (1 + x + (0.48 * x * x) + (0.235 * x * x * x));
  const change = current - target;
  const velocity = Number(velocities[key]) || 0;
  const temp = (velocity + (omega * change)) * delta;
  velocities[key] = (velocity - (omega * temp)) * decay;
  return target + ((change + temp) * decay);
}

function isViewSettled(view, target) {
  if (!view || !target) return false;
  if (Math.abs(view.scale - target.scale) > SETTLE_SCALE * Math.max(1, target.scale)) return false;
  return Math.hypot(view.x - target.x, view.y - target.y) <= SETTLE_DISTANCE;
}

/**
 * Foundry constrains any view it is asked for. Clamping the destination the same way up front keeps
 * the module's idea of the camera in step with what is actually on screen, so a framing that would
 * run off the canvas lands as close as the canvas allows instead of chasing a point it can never
 * reach.
 */
function clampView(position) {
  const scale = clampScale(position.scale);
  const viewport = getViewportSize();
  const dimensions = canvas?.dimensions;
  const width = Number(dimensions?.width) || 0;
  const height = Number(dimensions?.height) || 0;
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

function clampScale(scale) {
  const value = Number(scale);
  const max = Number(CONFIG?.Canvas?.maxZoom) || 3;
  const viewport = getViewportSize();
  const dimensions = canvas?.dimensions;
  const width = Number(dimensions?.width) || 0;
  const height = Number(dimensions?.height) || 0;
  const ratio = Math.max(width / Math.max(1, viewport.width), height / Math.max(1, viewport.height), max);
  const min = 1 / ratio;
  if (!Number.isFinite(value) || value <= 0) return min;
  return clamp(value, min, max);
}

/**
 * True while this client is mid-interaction on the canvas (dragging a token, drawing a ruler,
 * placing a preview). The camera stays off the canvas transform until that finishes.
 */
function isCanvasInteractionBusy() {
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

function interactionDragState() {
  const states = foundry?.canvas?.interaction?.MouseInteractionManager?.INTERACTION_STATES
    ?? globalThis.MouseInteractionManager?.INTERACTION_STATES;
  return Number(states?.DRAG) || 3;
}

function getActiveCombatant(combat) {
  if (combat?.combatant) return combat.combatant;
  const turns = combat?.turns;
  const turn = combat?.turn;
  if (Array.isArray(turns) && Number.isInteger(turn)) return turns[turn] ?? null;
  return null;
}

function getCombatantToken(combatant) {
  const direct = combatant?.token?.object ?? combatant?.tokenObject ?? combatant?.object;
  if (direct?.document) return direct;
  const tokenDocument = combatant?.token;
  if (tokenDocument?.object?.document) return tokenDocument.object;
  return getCanvasToken(combatant?.tokenId ?? tokenDocument?.id ?? combatant?.token?.document?.id);
}

function visibleTokens() {
  return (canvas?.tokens?.placeables ?? []).filter(isVisibleToken);
}

function getCanvasToken(tokenId) {
  if (!tokenId) return null;
  const layer = canvas?.tokens;
  if (typeof layer?.get === "function") return layer.get(tokenId) ?? null;
  return layer?.placeables?.find(token => token.document?.id === tokenId || token.id === tokenId) ?? null;
}

function isVisibleToken(token) {
  return Boolean(token?.document && !token.document.hidden && token.visible !== false);
}

function hasPlayerOwner(actor) {
  if (!actor?.ownership) return false;
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Object.entries(actor.ownership).some(([userId, level]) => userId !== "default" && level >= owner);
}

function isPartyToken(token) {
  return Boolean(token?.actor?.hasPlayerOwner || hasPlayerOwner(token?.actor));
}

function targetsOfToken(token) {
  const users = controllingUsers(token);
  const targets = [];
  for (const user of users) {
    for (const target of (user?.targets ?? [])) targets.push(target);
  }
  return targets;
}

function controllingUsers(token) {
  const users = (game?.users?.contents ?? []).filter(user => user?.active);
  const actor = token?.actor;
  const owners = users.filter(user => !user.isGM && isActorOwner(actor, user));
  if (owners.length) return owners;
  return users.filter(user => user.isGM);
}

function isActorOwner(actor, user) {
  if (!actor || !user) return false;
  if (typeof actor.testUserPermission === "function") {
    return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
  }
  const level = actor.ownership?.[user.id];
  return Number(level) >= (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
}

function tokenBounds(token, destination = null) {
  const gridSize = canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100;
  const document = token?.document;
  if (!document && !token) return null;
  const width = (destination?.width ?? document?.width ?? 1) * gridSize;
  const height = (destination?.height ?? document?.height ?? 1) * gridSize;
  return {
    x: destination?.x ?? document?.x ?? token?.x ?? 0,
    y: destination?.y ?? document?.y ?? token?.y ?? 0,
    width,
    height
  };
}

function hasTokenPositionChange(changes = {}) {
  return "x" in changes || "y" in changes;
}

function hasTokenFrameChange(changes = {}) {
  return hasTokenPositionChange(changes) || "hidden" in changes || "width" in changes || "height" in changes;
}

function unionBounds(bounds) {
  if (!bounds.length) return null;
  const minX = Math.min(...bounds.map(b => b.x));
  const minY = Math.min(...bounds.map(b => b.y));
  const maxX = Math.max(...bounds.map(b => b.x + b.width));
  const maxY = Math.max(...bounds.map(b => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function unionTokens(...groups) {
  const seen = new Set();
  return groups.flat().filter(token => {
    const id = token?.document?.id;
    if (!id) return false;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function getSceneBounds() {
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

function getViewportSize() {
  const screen = canvas?.app?.renderer?.screen;
  return { width: screen?.width ?? window.innerWidth, height: screen?.height ?? window.innerHeight };
}

function getCanvasView() {
  return {
    x: canvas?.stage?.pivot?.x ?? 0,
    y: canvas?.stage?.pivot?.y ?? 0,
    scale: canvas?.stage?.scale?.x ?? 1
  };
}

function setCanvasView(position) {
  if (typeof canvas?.pan !== "function") return setCanvasStageView(position);
  canvas.pan({ x: position.x, y: position.y, scale: position.scale, duration: 0 });
  return true;
}

function setCanvasStageView(position) {
  if (canvas?.stage?.pivot && canvas?.stage?.scale) {
    const viewport = getViewportSize();
    canvas.stage.pivot.set(position.x, position.y);
    canvas.stage.scale.set(position.scale, position.scale);
    canvas.stage.position?.set?.(viewport.width / 2, viewport.height / 2);
    return true;
  }
  return false;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
