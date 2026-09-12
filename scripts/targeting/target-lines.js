import { getActiveCombatant, getActiveSceneCombat, getCombatantToken } from "../combat-utils.js";
import { MODULE_ID, TARGET_LINE_VISIBILITY } from "../constants.js";
import { onCanvasFrame, prefersCalmMotion } from "../motion/engine.js";
import { getSetting, getTargetingSettings, isConfiguredStreamUser } from "../settings.js";
import { getCanvasToken, isVisibleToken, targetsOfToken } from "../token-utils.js";
import { TargetLine } from "./target-line.js";

/** Above rulers and cursors, below the scrolling combat text. */
const LAYER_Z_INDEX = 1050;
const HALO_BLUR_STRENGTH = 6;
const HALO_BLUR_QUALITY = 2;

/**
 * Draws a targeting line from the active combatant to every token it is targeting, on any client the
 * targeting settings allow. Each client decides for itself with its own visibility, so a line never
 * reveals a token that client cannot see.
 */
export class TargetLineController {
  lines = new Map();
  layer = null;
  halo = null;
  core = null;
  stopListening = null;
  syncQueued = false;

  registerHooks() {
    Hooks.on("canvasReady", () => {
      this.#teardown();
      this.#createLayer();
      this.refresh();
    });
    Hooks.on("canvasTearDown", () => this.#teardown());
    const refresh = () => this.refresh();
    for (const hook of [
      "targetToken",
      "combatStart",
      "combatTurnChange",
      "createCombat",
      "updateCombat",
      "deleteCombat",
      "createCombatant",
      "updateCombatant",
      "deleteCombatant",
      "deleteToken",
      "sightRefresh",
      "userConnected",
      `${MODULE_ID}.streamModeChanged`
    ]) Hooks.on(hook, refresh);
    Hooks.on("updateToken", (_doc, changes) => {
      if ("hidden" in changes || "disposition" in changes) refresh();
    });
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (["targetingSettings", "showTargetLines", "streamUserId"].includes(key)) refresh();
    });
    if (canvas?.ready) {
      this.#createLayer();
      this.refresh();
    }
  }

  /** Reconcile lines with the current combat and targets on the next frame; repeated calls coalesce. */
  refresh() {
    if (this.syncQueued) return;
    this.syncQueued = true;
    requestAnimationFrame(() => {
      this.syncQueued = false;
      try {
        this.#sync();
      } catch (error) {
        console.error(`${MODULE_ID} | Targeting line update failed`, error);
      }
    });
  }

  #sync() {
    if (!canvas?.ready || !this.layer || this.layer.destroyed) return;
    const settings = getTargetingSettings();
    const desired = this.#desiredLines(settings);
    for (const [key, line] of this.lines) {
      const wanted = desired.get(key);
      if (!wanted) {
        line.hide();
        continue;
      }
      line.setStyle(wanted.style);
      line.show();
    }
    const calm = prefersCalmMotion();
    for (const [key, wanted] of desired) {
      if (this.lines.has(key)) continue;
      const line = new TargetLine({
        sourceId: wanted.sourceId,
        targetId: wanted.targetId,
        halo: this.halo,
        core: this.core,
        style: wanted.style,
        calm,
        onGone: gone => {
          if (this.lines.get(key) === gone) this.lines.delete(key);
          this.#updateListening();
        }
      });
      this.lines.set(key, line);
      line.show();
    }
    this.#updateListening();
  }

  #desiredLines(settings) {
    const desired = new Map();
    if (!canShowLines(settings)) return desired;
    const combat = getActiveSceneCombat();
    if (!combat?.started) return desired;
    const source = getCombatantToken(getActiveCombatant(combat));
    if (!isVisibleToken(source)) return desired;
    for (const target of targetsOfToken(source)) {
      if (!isVisibleToken(target)) continue;
      const sourceId = source.document.id;
      const targetId = target.document.id;
      desired.set(`${sourceId}>${targetId}`, {
        sourceId,
        targetId,
        style: { color: relationColor(source, target, settings), intensity: Number(settings.intensity) || 1 }
      });
    }
    return desired;
  }

  #render() {
    if (!canvas?.ready) return;
    const scale = canvas.stage?.scale?.x ?? 1;
    const gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
    for (const line of this.lines.values()) {
      const source = getCanvasToken(line.sourceId);
      const target = getCanvasToken(line.targetId);
      if (!source || !target || source.destroyed || target.destroyed) {
        line.destroy();
        continue;
      }
      line.render({ source, target, scale, gridSize });
    }
  }

  #updateListening() {
    if (this.lines.size && !this.stopListening) this.stopListening = onCanvasFrame(() => this.#render());
    else if (!this.lines.size && this.stopListening) {
      this.stopListening();
      this.stopListening = null;
    }
  }

  #createLayer() {
    const parent = canvas?.interface;
    if (!parent) return;
    const layer = new PIXI.Container();
    layer.eventMode = "none";
    layer.interactiveChildren = false;
    layer.zIndex = LAYER_Z_INDEX;

    // Halos share one blur so the glow costs a single filter pass however many lines there are.
    const halo = layer.addChild(new PIXI.Container());
    const blur = new PIXI.BlurFilter(HALO_BLUR_STRENGTH, HALO_BLUR_QUALITY);
    blur.blendMode = PIXI.BLEND_MODES.ADD;
    halo.filters = [blur];
    const core = layer.addChild(new PIXI.Container());

    parent.addChild(layer);
    parent.sortDirty = true;
    this.layer = layer;
    this.halo = halo;
    this.core = core;
  }

  #teardown() {
    for (const line of [...this.lines.values()]) line.destroy();
    this.lines.clear();
    this.#updateListening();
    if (this.layer && !this.layer.destroyed) {
      this.layer.parent?.removeChild(this.layer);
      this.layer.destroy({ children: true });
    }
    this.layer = null;
    this.halo = null;
    this.core = null;
  }
}

function canShowLines(settings) {
  if (!settings.enabled) return false;
  if (getSetting("showTargetLines") === false) return false;
  switch (settings.visibility) {
    case TARGET_LINE_VISIBILITY.streamOnly:
      return isConfiguredStreamUser();
    case TARGET_LINE_VISIBILITY.gmAndStream:
      return Boolean(game.user?.isGM) || isConfiguredStreamUser();
    default:
      return true;
  }
}

/**
 * Line color by relationship. Secret dispositions count as neutral so the color never gives away a
 * token's hidden allegiance.
 */
function relationColor(source, target, settings) {
  const side = sideOf(source);
  const targetSide = sideOf(target);
  let color = settings.colorOther;
  if (side === 1 && targetSide === -1) color = settings.colorFriendlyToHostile;
  else if (side === -1 && targetSide === 1) color = settings.colorHostileToFriendly;
  else if (side !== 0 && side === targetSide) color = settings.colorSameSide;
  return hexToNumber(color);
}

function sideOf(token) {
  const dispositions = CONST.TOKEN_DISPOSITIONS;
  const disposition = token?.document?.disposition;
  if (disposition === dispositions.FRIENDLY) return 1;
  if (disposition === dispositions.HOSTILE) return -1;
  return 0;
}

function hexToNumber(hex) {
  const value = Number.parseInt(String(hex ?? "").replace("#", ""), 16);
  return Number.isFinite(value) ? value : 0xffffff;
}
