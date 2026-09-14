import { getActiveCombatant, getActiveSceneCombat, getCombatantToken } from "../combat-utils.js";
import { MODULE_ID, TARGET_LINE_VISIBILITY } from "../constants.js";
import { createTimer, onCanvasFrame, prefersCalmMotion } from "../motion/engine.js";
import { getSetting, getTargetingSettings, isConfiguredStreamUser } from "../settings.js";
import { getCanvasToken, isVisibleToken, playerControllingUsers, targetsOfToken, turnPlayers } from "../token-utils.js";
import { OriginRing, TargetLine } from "./target-line.js";

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
  /** Hand-off origin rings still playing: at most one sink per old token and one rise per new token. */
  rings = new Set();
  layer = null;
  halo = null;
  core = null;
  glint = null;
  stopListening = null;
  syncQueued = false;
  turnContext = undefined;
  turnSourceId = null;
  carriedTargets = new Map();
  /** While set, the lines of `sourceId` wait for the previous turn's lines to retract. */
  handoff = null;
  /** The token whose lines a finished hand-off is about to launch, so one ring can rise out of it. */
  pendingRiseId = null;
  #renderArgs = { source: null, target: null, scale: 1, gridSize: 100, resolution: 1 };

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
    const sourceId = source?.document?.id ?? null;
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
    this.turnSourceId = sourceId;
    // A re-sort or an insert that moves the turn index while the same token is still acting is not a new turn
    // for the hand-off: a pending retract and beat carry on.
    if (sourceId === previousSourceId) return;
    this.#cancelHandoff();
    if (!firstContext) this.#beginHandoff(getCanvasToken(previousSourceId), source);
  }

  /**
   * When one player's turn passes to another token of theirs (a character, then its companion), their
   * lines would otherwise leap straight from one token to the next. Instead the previous token's lines
   * retract completely, a beat passes, and only then do the current token's lines launch, even onto the
   * same targets. One ring sinks into the old token and one rises out of the new. Turns between different
   * players, or run by the GM, change over at once.
   */
  #beginHandoff(previous, current) {
    const fromId = previous?.document?.id;
    const sourceId = current?.document?.id;
    if (!fromId || !sourceId || fromId === sourceId) return;
    if (!sameTurnPlayer(previous, current)) return;
    const outgoing = [...this.lines.values()].filter(line => line.origin !== sourceId);
    // Nothing on screen to retract: there is nothing to wait for.
    if (!outgoing.length) return;
    const drawnFromPrevious = outgoing.find(line => line.isDrawnFrom(fromId));
    if (drawnFromPrevious) this.#addRing("sink", fromId, drawnFromPrevious.color);
    const handoff = { sourceId, timer: null };
    handoff.timer = createTimer({
      duration: Math.max(...outgoing.map(line => line.retractMs + line.beatMs)),
      onComplete: () => {
        if (this.handoff !== handoff) return;
        this.handoff = null;
        this.pendingRiseId = sourceId;
        this.refresh();
      }
    });
    this.handoff = handoff;
  }

  #cancelHandoff() {
    this.handoff?.timer?.cancel?.();
    this.handoff = null;
    this.pendingRiseId = null;
  }

  #sync() {
    if (!canvas?.ready || !this.layer || this.layer.destroyed) return;
    const settings = getTargetingSettings();
    const desired = this.#desiredLines(settings);
    const waitingSourceId = this.handoff?.sourceId ?? null;
    if (waitingSourceId) this.#keepSharedLines(desired, waitingSourceId);
    for (const [key, line] of this.lines) {
      const wanted = desired.get(key);
      if (!wanted) {
        line.hide();
        continue;
      }
      // The incoming token's lines launch together once the hand-off's retract and beat are over.
      if (wanted.sourceId === waitingSourceId) continue;
      line.setStyle(wanted.style);
      line.show();
    }
    const calm = prefersCalmMotion();
    for (const [key, wanted] of desired) {
      if (this.lines.has(key) || wanted.sourceId === waitingSourceId) continue;
      const line = new TargetLine({
        sourceId: wanted.sourceId,
        targetId: wanted.targetId,
        halo: this.halo,
        core: this.core,
        glint: this.glint,
        style: wanted.style,
        calm,
        onGone: gone => this.#forget(gone)
      });
      this.lines.set(key, line);
      line.show();
    }
    this.#riseFromLaunchingToken(desired);
    this.#updateListening();
  }

  /**
   * During a hand-off, a target the incoming token shares with the outgoing one keeps its line: the body
   * retracts into the old source while the reticle stays up, dimmed, and relaunches from the new source after
   * the beat. Only a target that changes collapses its reticle.
   */
  #keepSharedLines(desired, sourceId) {
    for (const [key, wanted] of desired) {
      if (wanted.sourceId !== sourceId || this.lines.has(key)) continue;
      for (const [heldKey, line] of this.lines) {
        if (!line.canHandOff(wanted.targetId, sourceId)) continue;
        this.lines.delete(heldKey);
        this.lines.set(key, line);
        line.retarget(sourceId);
        break;
      }
    }
  }

  /** As a finished hand-off launches the new token's lines, one ring rises out of it, however many there are. */
  #riseFromLaunchingToken(desired) {
    const tokenId = this.pendingRiseId;
    if (!tokenId) return;
    this.pendingRiseId = null;
    for (const wanted of desired.values()) {
      if (wanted.sourceId !== tokenId) continue;
      this.#addRing("rise", tokenId, wanted.style.color);
      return;
    }
  }

  #addRing(kind, tokenId, color) {
    if (!this.layer || this.layer.destroyed || prefersCalmMotion()) return;
    const ring = new OriginRing({
      layer: this.core,
      tokenId,
      kind,
      color,
      onGone: gone => {
        this.rings.delete(gone);
        this.#updateListening();
      }
    });
    this.rings.add(ring);
    this.#updateListening();
  }

  /** Lines can change key during a hand-off, so a finished line is found by identity. */
  #forget(gone) {
    for (const [key, line] of this.lines) {
      if (line !== gone) continue;
      this.lines.delete(key);
      break;
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
    // A player's targets are their standing intent for their own creature, so they show from the first
    // frame of its turn, round after round. The GM's selection is left over from whichever NPC acted last,
    // so a GM-controlled turn only draws targets picked during that turn.
    const includeTarget = playerControllingUsers(source).length
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
    const args = this.#renderArgs;
    args.scale = canvas.stage?.scale?.x ?? 1;
    args.gridSize = canvas.grid?.size ?? canvas.dimensions?.size ?? 100;
    // Hairlines are one device pixel, so they need the renderer's resolution as well as the zoom.
    args.resolution = canvas.app?.renderer?.resolution ?? globalThis.devicePixelRatio ?? 1;
    for (const line of this.lines.values()) {
      const source = getCanvasToken(line.sourceId);
      const target = getCanvasToken(line.targetId);
      if (!source || !target || source.destroyed || target.destroyed) {
        line.destroy();
        continue;
      }
      args.source = source;
      args.target = target;
      line.render(args);
    }
    args.target = null;
    for (const ring of this.rings) {
      const token = getCanvasToken(ring.tokenId);
      if (!token || token.destroyed) {
        ring.destroy();
        continue;
      }
      args.source = token;
      ring.render(args);
    }
    args.source = null;
  }

  #updateListening() {
    const drawing = this.lines.size > 0 || this.rings.size > 0;
    if (drawing && !this.stopListening) this.stopListening = onCanvasFrame(() => this.#render());
    else if (!drawing && this.stopListening) {
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
    // The light sweep adds onto the glass beneath it; each line's glint Graphics sets its own ADD blend.
    const glint = layer.addChild(new PIXI.Container());

    parent.addChild(layer);
    parent.sortDirty = true;
    this.layer = layer;
    this.halo = halo;
    this.core = core;
    this.glint = glint;
  }

  #teardown() {
    this.#cancelHandoff();
    for (const ring of [...this.rings]) ring.destroy();
    this.rings.clear();
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
    this.glint = null;
  }
}

/**
 * Whether two turns belong to the same player, for a hand-off: their turn players (`turnPlayers`, the users
 * whose assigned character each token is, else its active non-GM owners) have at least one person in common.
 *
 * A player's own character followed by their unassigned companion hands off, as does a mount several players own
 * after any of their characters. Two players' characters do not, even where every player owns every character.
 * GM-controlled tokens have no turn players, so NPC turns never hand off.
 */
function sameTurnPlayer(previous, current) {
  const previousIds = new Set(turnPlayers(previous).map(user => user.id));
  return turnPlayers(current).some(user => previousIds.has(user.id));
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
