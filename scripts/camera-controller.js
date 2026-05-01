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
  }

  registerHooks() {
    Hooks.on("canvasReady", () => this.scheduleReframe({ animate: false, force: true }));
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
    Hooks.on("updateCombat", () => this.scheduleReframe());
    Hooks.on("updateCombatant", () => this.scheduleReframe());
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
    sendStreamCommand(STREAM_COMMANDS.reframe, { force: true, ...payload });
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

  async reframe({ animate = true, force = false } = {}) {
    this.pending = null;
    if (!canvas?.ready || (!this.streamMode.active && !force)) return false;
    const settings = getCameraSettings();
    const mode = this.getEffectiveMode(settings);
    if (mode === CAMERA_MODES.manual) return false;
    if (mode === CAMERA_MODES.scene) return this.frameScene({ animate, viewMode: settings.sceneViewMode });

    const tokens = this.getTokensForMode(mode, settings);
    if (!tokens.length) return false;
    return this.frameTokenBounds(tokens, { animate });
  }

  getEffectiveMode(settings = getCameraSettings()) {
    return getCurrentSceneCombat() ? settings.combatMode : settings.outOfCombatMode;
  }

  getTokensForMode(mode, settings = getCameraSettings()) {
    switch (mode) {
      case CAMERA_MODES.party:
        return unionTokens(visibleTokens().filter(isPartyToken), this.getVisibleTrackedTokens());
      case CAMERA_MODES.trackedToken:
        return this.getVisibleTrackedTokens();
      case CAMERA_MODES.combatants: {
        const combat = getCurrentSceneCombat();
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
      default:
        return [];
    }
  }

  getVisibleTrackedTokens() {
    return this.tokenTracking.getTrackedTokens().filter(isVisibleToken);
  }

  async frameScene({ animate = true, viewMode = SCENE_VIEW_MODES.fitBackground } = {}) {
    const bounds = getSceneBounds();
    if (!bounds) return;
    await this.applyBounds(bounds, { animate, fill: viewMode === SCENE_VIEW_MODES.fillBackground, clampZoom: false, usePadding: false });
  }

  async frameTokenBounds(tokens, { animate = true } = {}) {
    const bounds = unionBounds(tokens.map(token => tokenBounds(token, this.tokenDestinations.get(token.document?.id))).filter(Boolean));
    if (!bounds) return;
    await this.applyBounds(bounds, { animate, fill: false, clampZoom: true });
  }

  async applyBounds(bounds, { animate = true, fill = false, clampZoom = true, usePadding = true } = {}) {
    const settings = getCameraSettings();
    const viewport = getViewportSize();
    const gridPadding = usePadding ? Math.max(0, Number(settings.paddingGridSpaces) || 0) * (canvas?.grid?.size ?? canvas?.dimensions?.size ?? 100) : 0;
    const percentPadding = usePadding ? Math.max(0, Number(settings.paddingPercent) || 0) / 100 : 0;
    const padX = viewport.width * percentPadding + gridPadding;
    const padY = viewport.height * percentPadding + gridPadding;
    const usableWidth = Math.max(100, viewport.width - (padX * 2));
    const usableHeight = Math.max(100, viewport.height - (padY * 2));
    const widthScale = usableWidth / Math.max(1, bounds.width);
    const heightScale = usableHeight / Math.max(1, bounds.height);
    let scale = fill ? Math.max(widthScale, heightScale) : Math.min(widthScale, heightScale);

    if (clampZoom) {
      const min = Number(settings.minZoom) || 0.01;
      const max = Math.max(min, Number(settings.maxZoom) || min);
      scale = clamp(scale, min, max);
    }

    const position = {
      x: bounds.x + (bounds.width / 2),
      y: bounds.y + (bounds.height / 2),
      scale,
      duration: animate ? Math.max(0, Number(settings.animationDurationMs) || 0) : 0
    };

    try {
      if (position.duration > 0 && samePanTarget(position, this.panTarget)) return this.panPromise ?? true;
      if (position.duration > 0) return await this.animatePan(position);
      this.cancelPanAnimation();
      return setCanvasView(position);
    } catch (error) {
      console.warn(`${MODULE_ID} | Camera reframe failed`, error);
    }
  }

  animatePan(position) {
    this.cancelPanAnimation();
    const start = getCanvasView();
    const startedAt = performance.now();
    const duration = Math.max(0, Number(position.duration) || 0);
    this.panTarget = { x: position.x, y: position.y, scale: position.scale };

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

function getCurrentSceneCombat() {
  const combat = game.combat;
  if (!combat) return null;
  const sceneId = combat.scene?.id ?? combat.sceneId;
  if (!sceneId) return combat;
  return sceneId === canvas?.scene?.id ? combat : null;
}

function getCombatants(combat) {
  const combatants = combat?.combatants;
  if (!combatants) return [];
  if (Array.isArray(combatants)) return combatants;
  if (typeof combatants.contents !== "undefined") return combatants.contents;
  return Array.from(combatants);
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
