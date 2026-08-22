import { getActiveSceneCombat, getCombatants } from "./combat-utils.js";
import { CAMERA_MODES, MODULE_ID, SCENE_VIEW_MODES, STREAM_COMMANDS } from "./constants.js";
import { getCameraSettings } from "./settings.js";
import { sendStreamCommand } from "./socket.js";

export class CameraController {
  constructor(streamMode, tokenTracking) {
    this.streamMode = streamMode;
    this.tokenTracking = tokenTracking;
    this.pending = null;
    this.tokenDestinations = new Map();
    this.panFrame = null;
    this.panPromise = null;
    this.panResolve = null;
    this.panTarget = null;
    this.spotlightTarget = null;
  }

  registerHooks() {
    Hooks.on("canvasReady", () => {
      this.spotlightTarget = null;
      this.scheduleReframe({ animate: false, force: true });
    });
    Hooks.on("preUpdateToken", (doc, changes) => {
      if (!hasTokenFrameChange(changes)) return;
      this.cacheTokenDestination(doc, changes);
      this.scheduleReframe({ immediate: true });
    });
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
    Hooks.on("deleteToken", () => this.scheduleReframe());
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
    });
  }

  requestReframe(payload = {}) {
    sendStreamCommand(STREAM_COMMANDS.reframe, { force: true, explicit: true, ...payload });
  }

  scheduleReframe(options = {}) {
    if (!this.streamMode.active) return;
    if (options.force || options.immediate) {
      window.clearTimeout(this.pending);
      this.pending = null;
      return this.reframe(options);
    }
    if (this.pending) return;
    const delay = options.immediate ? 0 : 100;
    this.pending = window.setTimeout(() => this.reframe(options), delay);
  }

  async reframe({ animate = true, force = false, explicit = false } = {}) {
    this.pending = null;
    if (!canvas?.ready || (!this.streamMode.active && !force)) return false;
    const settings = getCameraSettings();
    const mode = this.getEffectiveMode(settings);
    const reapply = force || explicit;
    if (mode === CAMERA_MODES.manual) return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    if (mode === CAMERA_MODES.scene) return this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply });

    if (mode === CAMERA_MODES.spotlight) {
      const spotlightToken = this.getSpotlightToken(settings);
      if (spotlightToken) return this.frameSpotlight(spotlightToken, { animate, force: reapply });
      this.spotlightTarget = null;
      const fallback = this.getTokensForMode(CAMERA_MODES.combatants, settings);
      if (fallback.length) return this.frameTokenBounds(fallback, { animate, force: reapply });
      if (!getActiveSceneCombat()) return this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply });
      return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    }
    this.spotlightTarget = null;

    const tokens = this.getTokensForMode(mode, settings);
    if (!tokens.length) return explicit ? this.frameScene({ animate, viewMode: settings.sceneViewMode, force: reapply }) : false;
    return this.frameTokenBounds(tokens, { animate, force: reapply });
  }

  getEffectiveMode(settings = getCameraSettings()) {
    return getActiveSceneCombat() ? settings.combatMode : settings.outOfCombatMode;
  }

  getTokensForMode(mode, settings = getCameraSettings()) {
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

  async frameScene({ animate = true, viewMode = SCENE_VIEW_MODES.fitBackground, force = false } = {}) {
    const bounds = getSceneBounds();
    if (!bounds) return;
    await this.applyBounds(bounds, { animate, fill: viewMode === SCENE_VIEW_MODES.fillBackground, clampZoom: false, usePadding: false, force });
  }

  async frameTokenBounds(tokens, { animate = true, force = false } = {}) {
    const bounds = unionBounds(tokens.map(token => tokenBounds(token, this.tokenDestinations.get(token.document?.id))).filter(Boolean));
    if (!bounds) return;
    await this.applyBounds(bounds, { animate, fill: false, clampZoom: true, force });
  }

  async applyBounds(bounds, { animate = true, fill = false, clampZoom = true, usePadding = true, force = false } = {}) {
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
      duration: animate ? Math.max(0, Number(settings.animationDurationMs) || 0) : 0
    };
    return this.applyPosition(position, { force });
  }

  /**
   * Spotlight framing ignores fit/fill bounds math entirely: the active token is centered and the
   * canvas is set to the configured spotlight zoom, so the operator gets the same framing distance
   * on every turn regardless of token size or how many combatants are on the scene.
   */
  async frameSpotlight(token, { animate = true, force = false } = {}) {
    const settings = getCameraSettings();
    const tokenId = token?.document?.id ?? null;
    const bounds = tokenBounds(token, this.tokenDestinations.get(tokenId));
    if (!bounds) return false;
    const viewport = getViewportSize();
    const padding = getCameraPadding(settings, viewport);
    const scale = spotlightZoom(settings);
    const position = {
      ...centeredPosition(bounds, scale, padding),
      duration: animate ? Math.max(0, Number(settings.animationDurationMs) || 0) : 0
    };

    const previous = this.spotlightTarget;
    this.spotlightTarget = { tokenId, x: position.x, y: position.y, scale };
    if (position.duration > 0 && !force && samePanTarget(position, this.panTarget)) return this.panPromise ?? true;
    if (position.duration > 0 && shouldPullBack(settings, previous, position, tokenId)) {
      return this.runSpotlightPullback(position, settings, { force });
    }
    return this.applyPosition(position, { force });
  }

  /**
   * Zoom out from wherever the camera currently sits, travel to the new token at that wider zoom,
   * then zoom back in. Panning at a wider zoom keeps long token moves and turn changes readable
   * on stream instead of smearing the map across the frame.
   */
  async runSpotlightPullback(position, settings, { force = false } = {}) {
    const start = getCanvasView();
    const factor = pullbackFactor(settings);
    const pullDuration = Math.max(0, Number(settings.spotlightPullbackDurationMs) || 0);
    const pullScale = Math.max(0.01, Math.min(start.scale, position.scale) / factor);
    const final = { x: position.x, y: position.y, scale: position.scale };
    const phases = [];

    if (pullDuration > 0 && pullScale < start.scale - 0.001) phases.push({ x: start.x, y: start.y, scale: pullScale, duration: pullDuration });
    phases.push({ x: position.x, y: position.y, scale: pullScale, duration: position.duration });
    if (pullDuration > 0 && pullScale < position.scale - 0.001) phases.push({ ...final, duration: pullDuration });
    else phases.push({ ...final, duration: 0 });

    try {
      if (force) this.cancelPanAnimation();
      for (const phase of phases) {
        if (phase.duration <= 0) {
          this.cancelPanAnimation();
          setCanvasView(phase);
          continue;
        }
        const completed = await this.animatePan(phase, final);
        if (!completed) return false;
      }
      return true;
    } catch (error) {
      console.warn(`${MODULE_ID} | Spotlight pull-back failed`, error);
      return false;
    }
  }

  async applyPosition(position, { force = false } = {}) {
    try {
      if (force) this.cancelPanAnimation();
      if (position.duration > 0 && !force && samePanTarget(position, this.panTarget)) return this.panPromise ?? true;
      if (position.duration > 0) return await this.animatePan(position);
      this.cancelPanAnimation();
      return setCanvasView(position);
    } catch (error) {
      console.warn(`${MODULE_ID} | Camera reframe failed`, error);
    }
  }

  animatePan(position, finalTarget = null) {
    this.cancelPanAnimation();
    const start = getCanvasView();
    const startedAt = performance.now();
    const duration = Math.max(0, Number(position.duration) || 0);
    this.panTarget = finalTarget
      ? { x: finalTarget.x, y: finalTarget.y, scale: finalTarget.scale }
      : { x: position.x, y: position.y, scale: position.scale };

    this.panPromise = new Promise(resolve => {
      this.panResolve = resolve;
      const step = now => {
        const progress = duration <= 0 ? 1 : clamp((now - startedAt) / duration, 0, 1);
        const eased = easeOutCubic(progress);
        setCanvasView({
          x: lerp(start.x, position.x, eased),
          y: lerp(start.y, position.y, eased),
          scale: lerp(start.scale, position.scale, eased),
          duration: 0
        });

        if (progress >= 1) {
          this.panFrame = null;
          this.panPromise = null;
          this.panResolve = null;
          this.panTarget = null;
          resolve(true);
          return;
        }
        this.panFrame = requestAnimationFrame(step);
      };
      this.panFrame = requestAnimationFrame(step);
    });
    return this.panPromise;
  }

  cancelPanAnimation() {
    if (this.panFrame) cancelAnimationFrame(this.panFrame);
    if (this.panResolve) this.panResolve(false);
    this.panFrame = null;
    this.panPromise = null;
    this.panResolve = null;
    this.panTarget = null;
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

function centeredPosition(bounds, scale, padding) {
  return {
    x: bounds.x + (bounds.width / 2) - ((padding.left - padding.right) / 2 / scale),
    y: bounds.y + (bounds.height / 2) - ((padding.top - padding.bottom) / 2 / scale),
    scale
  };
}

function spotlightZoom(settings) {
  const zoom = Number(settings.spotlightZoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function pullbackFactor(settings) {
  const factor = Number(settings.spotlightPullbackFactor);
  return Number.isFinite(factor) && factor > 1 ? factor : 1;
}

function shouldPullBack(settings, previous, position, tokenId) {
  if (settings.spotlightPullback === false) return false;
  if (pullbackFactor(settings) <= 1) return false;
  if (!(Number(settings.spotlightPullbackDurationMs) > 0)) return false;
  if (!previous) return false;
  if (previous.tokenId !== tokenId) return true;
  const threshold = (canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) / 4;
  return Math.hypot(position.x - previous.x, position.y - previous.y) > threshold;
}

function getCameraPadding(settings, viewport) {
  const gridSize = canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100;
  return {
    top: sidePadding(settings.paddingPercentTop, viewport.height, settings.paddingGridSpacesTop, gridSize),
    right: sidePadding(settings.paddingPercentRight, viewport.width, settings.paddingGridSpacesRight, gridSize),
    bottom: sidePadding(settings.paddingPercentBottom, viewport.height, settings.paddingGridSpacesBottom, gridSize),
    left: sidePadding(settings.paddingPercentLeft, viewport.width, settings.paddingGridSpacesLeft, gridSize)
  };
}

function sidePadding(percent, viewportSize, gridSpaces, gridSize) {
  return (Math.max(0, Number(percent) || 0) / 100 * viewportSize) + (Math.max(0, Number(gridSpaces) || 0) * gridSize);
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

function tokenBounds(token, destination = null) {
  const gridSize = canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100;
  const document = token?.document;
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
  if (typeof canvas?.pan === "function") return canvas.pan({ ...position, duration: 0 });
  return setCanvasStageView(position);
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

function lerp(start, end, amount) {
  return start + ((end - start) * amount);
}

function easeOutCubic(value) {
  return 1 - Math.pow(1 - value, 3);
}

function samePanTarget(a, b) {
  if (!a || !b) return false;
  return Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.scale - b.scale) < 0.001;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
