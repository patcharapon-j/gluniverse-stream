import { getActiveCombatant, getActiveSceneCombat, getCombatantToken } from "../combat-utils.js";
import { MODULE_ID, TARGET_LINE_MOTION, TARGET_LINE_VISIBILITY } from "../constants.js";
import { createTimer, onCanvasFrame, prefersCalmMotion } from "../motion/engine.js";
import { getSetting, getTargetingSettings, isConfiguredStreamUser } from "../settings.js";
import { getCanvasToken, isVisibleToken, playerControllers, targetsOfToken } from "../token-utils.js";
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
  turnContext = undefined;
  turnSourceId = null;
  carriedTargets = new Map();
  /** While set, the lines of `sourceId` wait for the previous turn's lines to retract. */
  handoff = null;

  registerHooks() {
    Hooks.on("canvasReady", () => {
      this.#teardown();
      this.#createLayer();
      this.refresh();
    });
    Hooks.on("canvasTearDown", () => this.#teardown());
    const refresh = () => this.refresh();
    Hooks.on("targetToken", (user, token) => {
      this.#updateTurnContext();
      // A fresh target event belongs to this turn, even if it arrives before the queued redraw.
      this.carriedTargets.get(user.id)?.delete(token.document.id);
      this.refresh();
    });
    for (const hook of [
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
    this.#updateTurnContext();
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

  #updateTurnContext() {
    const combat = getActiveSceneCombat();
    const combatant = combat?.started ? getActiveCombatant(combat) : null;
    const context = combat?.started
      ? JSON.stringify([canvas?.scene?.id, combat.id, combat.round, combat.turn, combatant?.id])
      : null;
    if (context === this.turnContext) return;
    const firstContext = this.turnContext === undefined;
    const previousSourceId = this.turnSourceId;
    const source = getCombatantToken(combatant);
    this.carriedTargets.clear();
    // Foundry targets belong to users, not creatures. Record every selection standing at the turn change;
    // on a GM-controlled turn these are not reassigned to the next creature, including another NPC the same
    // GM runs (see #desiredLines).
    if (!firstContext) {
      for (const user of game.users?.contents ?? []) {
        this.carriedTargets.set(user.id, new Set(
          [...(user.targets ?? [])].map(target => target.document.id)
        ));
      }
    }
    this.turnContext = context;
    this.turnSourceId = source?.document?.id ?? null;
    this.#cancelHandoff();
    if (!firstContext) this.#beginHandoff(getCanvasToken(previousSourceId), source);
  }

  /**
   * When one player's turn passes to another token of theirs (a character, then its companion), their
   * lines would otherwise leap straight from one token to the next. Instead the previous token's lines
   * retract completely, a beat passes, and only then do the current token's lines launch, even onto the
   * same targets. Turns between different players, or run by the GM, change over at once.
   */
  #beginHandoff(previous, current) {
    const sourceId = current?.document?.id;
    if (!previous || !sourceId || previous.document?.id === sourceId) return;
    if (!sharesPlayerController(previous, current)) return;
    const retracting = [...this.lines.values()].filter(line => !line.destroyed && line.sourceId !== sourceId);
    // Nothing on screen to retract: there is nothing to wait for.
    if (!retracting.length) return;
    const retractMs = Math.max(...retracting.map(line => fullRetractMs(line.calm)));
    const handoff = { sourceId, timer: null };
    handoff.timer = createTimer({
      duration: retractMs + TARGET_LINE_MOTION.handoffBeatMs,
      onComplete: () => {
        if (this.handoff !== handoff) return;
        this.handoff = null;
        this.refresh();
      }
    });
    this.handoff = handoff;
  }

  #cancelHandoff() {
    this.handoff?.timer?.cancel?.();
    this.handoff = null;
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
    if (this.handoff?.sourceId === source.document.id) return desired;
    // A player's targets are their standing intent for their own creature, so they show from the first
    // frame of its turn, round after round. The GM's selection is left over from whichever NPC acted last,
    // so a GM-controlled turn only draws targets picked during that turn.
    const includeTarget = playerControllers(source).length
      ? undefined
      : (user, target) => !this.carriedTargets.get(user.id)?.has(target.document.id);
    for (const target of targetsOfToken(source, includeTarget)) {
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
    this.#cancelHandoff();
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

/**
 * Whether two turns belong to the same player, for a turn handoff: the tokens' controlling players (the
 * active non-GM owners, the same rule `targetsOfToken` uses) have at least one person in common.
 *
 * Overlap rather than equality, because a token several players share, such as a mount or a party
 * companion, could be acted for by either of them, so its turn after either one's own character reads as
 * the same hands moving on. Offline owners never count. GM-controlled tokens never share: the GM runs every
 * NPC, and treating that as one player would put a pause between every pair of NPC turns.
 */
function sharesPlayerController(previous, current) {
  const previousIds = new Set(playerControllers(previous).map(user => user.id));
  return playerControllers(current).some(user => previousIds.has(user.id));
}

/** How long a fully drawn line takes to leave the screen, matching `TargetLine#hide`. */
function fullRetractMs(calm) {
  if (calm) return TARGET_LINE_MOTION.calmFadeOutMs;
  return Math.max(
    TARGET_LINE_MOTION.ringOutMs,
    TARGET_LINE_MOTION.retractDelayMs + Math.max(TARGET_LINE_MOTION.retractMs, TARGET_LINE_MOTION.selfRetractMs)
  );
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
