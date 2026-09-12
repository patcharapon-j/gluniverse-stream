import { getActiveCombatant, getActiveSceneCombat, getCombatants, getCombatantToken } from "../combat-utils.js";
import { CAMERA_MODES, MODULE_ID, SCENE_VIEW_MODES, STREAM_COMMANDS } from "../constants.js";
import { getCameraSettings } from "../settings.js";
import { sendStreamCommand } from "../socket.js";
import { isPartyToken, isVisibleToken, targetsOfToken, unionTokens, visibleTokens } from "../token-utils.js";
import {
  centeredPosition,
  clamp,
  clampView,
  fitScale,
  getCameraPadding,
  getCanvasView,
  getSceneBounds,
  getViewportSize,
  isBoundsInView,
  isCanvasInteractionBusy,
  NO_PADDING,
  tokenBounds,
  unionBounds
} from "./framing.js";
import { CameraMotion } from "./motion.js";

const REFRAME_DEBOUNCE_MS = 100;
const MAX_INTERACTION_RETRIES = 120;
/**
 * A spotlight move whose destination already sits inside this central share of the screen just pans.
 * Anything further out flies: zoom out, cross, zoom back in.
 */
const SPOTLIGHT_GLIDE_ZONE = 0.5;

export class CameraController {
  constructor(streamMode, tokenTracking) {
    this.streamMode = streamMode;
    this.tokenTracking = tokenTracking;
    this.motion = new CameraMotion();
    this.queued = null;
    this.queuedFrame = null;
    this.queuedTimeout = null;
    this.busyRetries = 0;
  }

  registerHooks() {
    Hooks.on("canvasReady", () => {
      this.motion.stop();
      this.scheduleReframe({ animate: false, force: true });
    });
    Hooks.on("canvasTearDown", () => this.motion.stop());
    /**
     * Camera work never runs from `preUpdateToken`. That hook is part of the document update workflow
     * that Foundry's movement pipeline drives, and mutating the canvas transform from inside it fights
     * the live drag/ruler interaction that issued the move, which can cancel the movement outright.
     * Reframing therefore only reacts to committed updates, always off the hook's own call stack, so
     * the module can never stop a token from moving.
     */
    Hooks.on("updateToken", (doc, changes) => {
      if (!hasTokenFrameChange(changes)) return;
      this.scheduleReframe({ immediate: hasTokenPositionChange(changes) });
    });
    Hooks.on("createToken", () => this.scheduleReframe());
    Hooks.on("deleteToken", () => this.scheduleReframe());
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
      else this.motion.stop();
    });
  }

  requestReframe(payload = {}) {
    sendStreamCommand(STREAM_COMMANDS.reframe, { force: true, explicit: true, ...payload });
  }

  /**
   * Reframes are always queued and run on a later animation frame. Nothing here touches the canvas
   * synchronously from a Foundry hook, so a reframe can never interleave with a document update or a
   * canvas interaction that is still in progress.
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

  /**
   * The queued reframe runs detached from whatever scheduled it, so nothing is left to observe its
   * result. Failures are logged here rather than surfacing as an unhandled rejection, which is how a
   * broken reframe could otherwise look like a camera that simply never moved.
   */
  #queueFrame() {
    if (this.queuedFrame) return;
    this.queuedFrame = requestAnimationFrame(() => {
      this.queuedFrame = null;
      const options = this.queued ?? {};
      this.queued = null;
      Promise.resolve(this.reframe(options)).catch(error => console.error(`${MODULE_ID} | Camera reframe failed`, error));
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
    const frameScene = () => this.frameScene({ animate, viewMode: settings.sceneViewMode, settings });
    if (mode === CAMERA_MODES.manual) return explicit ? frameScene() : false;
    if (mode === CAMERA_MODES.scene) return frameScene();

    if (mode === CAMERA_MODES.spotlight) {
      const spotlightToken = this.getSpotlightToken(settings);
      if (spotlightToken) return this.frameSpotlight(spotlightToken, { animate, settings });
      const fallback = this.getTokensForMode(CAMERA_MODES.combatants, settings);
      if (fallback.length) return this.frameTokenBounds(fallback, { animate, settings });
      if (!getActiveSceneCombat()) return frameScene();
      return explicit ? frameScene() : false;
    }

    const tokens = this.getTokensForMode(mode, settings);
    if (!tokens.length) return explicit ? frameScene() : false;
    return this.frameTokenBounds(tokens, { animate, settings });
  }

  getEffectiveMode(settings = getCameraSettings()) {
    return getActiveSceneCombat() ? settings.combatMode : settings.outOfCombatMode;
  }

  /**
   * Tokens to frame for a mode, plus whatever those tokens are currently targeting, so an attack across
   * the map keeps both ends of the action in the shot.
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
        const combatantTokens = getCombatants(combat)
          .filter(combatant => !(settings.excludeDefeated !== false && combatant.defeated))
          .map(getCombatantToken)
          .filter(isVisibleToken);
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
   * combat is running on the canvas scene. Tracked tokens are deliberately not unioned in: spotlight is
   * a single-token framing, so adding other tokens would pull the camera off the active token. Tokens
   * the active token is targeting are the one exception, handled in `frameSpotlight`.
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

  getTargetTokens(sources, settings = getCameraSettings()) {
    if (settings.includeTargets === false) return [];
    const sourceIds = new Set(sources.map(token => token?.document?.id).filter(Boolean));
    const targets = sources.flatMap(source => targetsOfToken(source))
      .filter(target => !sourceIds.has(target.document.id) && isVisibleToken(target));
    return unionTokens(targets);
  }

  frameScene({ animate = true, viewMode = SCENE_VIEW_MODES.fitBackground, settings = getCameraSettings() } = {}) {
    const bounds = getSceneBounds();
    if (!bounds) return false;
    const scale = fitScale(bounds, getViewportSize(), NO_PADDING, viewMode === SCENE_VIEW_MODES.fillBackground);
    return this.applyView(centeredPosition(bounds, scale), { animate, settings });
  }

  frameTokenBounds(tokens, { animate = true, settings = getCameraSettings() } = {}) {
    const bounds = unionBounds(tokens.map(tokenBounds).filter(Boolean));
    if (!bounds) return false;
    const viewport = getViewportSize();
    const padding = getCameraPadding(settings, viewport);
    const min = Number(settings.minZoom) || 0.01;
    const max = Math.max(min, Number(settings.maxZoom) || min);
    const scale = clamp(fitScale(bounds, viewport, padding), min, max);
    return this.applyView(centeredPosition(bounds, scale, padding), { animate, settings });
  }

  /**
   * Spotlight framing normally ignores fit/fill bounds math entirely: the active token is centered and
   * the canvas is set to the configured spotlight zoom, so the operator gets the same framing distance
   * on every turn. When the active token is targeting something, the framing widens just far enough to
   * hold the token and its targets, never zooming in past the spotlight zoom and never past `minZoom`
   * on the way out.
   *
   * Spotlight is also the one mode that flies: when the token's destination is outside the central part
   * of the screen, the camera zooms out, crosses, and zooms back in rather than panning.
   */
  frameSpotlight(token, { animate = true, settings = getCameraSettings() } = {}) {
    const tokenFrame = tokenBounds(token);
    const boundsList = [tokenFrame, ...this.getTargetTokens([token], settings).map(tokenBounds)].filter(Boolean);
    const bounds = unionBounds(boundsList);
    if (!bounds) return false;

    const viewport = getViewportSize();
    const padding = getCameraPadding(settings, viewport);
    let scale = spotlightZoom(settings);
    if (boundsList.length > 1) {
      scale = Math.max(Math.min(scale, fitScale(bounds, viewport, padding)), Number(settings.minZoom) || 0.01);
    }
    const flight = !isBoundsInView(tokenFrame, getCanvasView(), SPOTLIGHT_GLIDE_ZONE);
    return this.applyView(centeredPosition(bounds, scale, padding), { animate, settings, flight });
  }

  applyView(position, { animate = true, settings = getCameraSettings(), flight = false } = {}) {
    try {
      const view = clampView(position);
      if (!animate) return this.motion.snap(view);
      return this.motion.moveTo(view, { speed: settings.panSpeed, travelZoomOut: settings.travelZoomOut, flight });
    } catch (error) {
      console.warn(`${MODULE_ID} | Camera reframe failed`, error);
      return false;
    }
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

function spotlightZoom(settings) {
  const zoom = Number(settings.spotlightZoom);
  return Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
}

function hasTokenPositionChange(changes = {}) {
  return "x" in changes || "y" in changes;
}

function hasTokenFrameChange(changes = {}) {
  return hasTokenPositionChange(changes) || "hidden" in changes || "width" in changes || "height" in changes;
}
