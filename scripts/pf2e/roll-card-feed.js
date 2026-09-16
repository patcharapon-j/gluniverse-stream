import { RollCard } from "../cards/roll-card.js";
import { waitForDiceAnimation } from "../dice-wait.js";
import { getChatSettings, getDefaultRollArt } from "../settings.js";
import { portraitFramer } from "../framing/portrait-framer.js";
import { artFor, readMessage } from "./read-message.js";
import { snapshotMessage } from "./snapshot.js";

/** Damage merges into the card its attack or cast made, if that card is this recent and still up. */
export const MERGE_WINDOW_MS = 60_000;
/**
 * PF2e rerolls by deleting the old message and posting a new one with the same flags. A deleted check
 * card waits this long for its reroll before it leaves.
 */
const REROLL_GRACE_MS = 2_000;

/**
 * Turns new PF2e chat messages into roll cards on the stream, and keeps them in step: damage merges
 * under its attack, a spell cast becomes its attack roll, and a reroll rewrites its card in place.
 * Cards share the chat overlay's stack, so `maxVisible` and removal cover both kinds of card.
 */
export class RollCardFeed {
  constructor(overlay) {
    this.overlay = overlay;
    /** messageId -> record, for the message each card currently shows (and every message merged into it). */
    this.byMessageId = new Map();
    /** rerollKey -> record, for check cards whose message was just deleted. */
    this.awaitingReroll = new Map();
  }

  async handleCreate(message) {
    const snapshot = snapshotMessage(message);
    const model = readMessage(snapshot);
    if (!model) return;
    const rerollKey = rerollKeyOf(snapshot);

    // Claim a rerolled card before the dice wait, so its grace timer cannot remove it meanwhile.
    const rerolled = model.isReroll ? this.claimReroll(rerollKey) : null;

    await waitForDiceAnimation(message);
    if (!this.overlay.streamMode.active || !game.messages?.get?.(message.id)) {
      if (rerolled) this.retire(rerolled);
      return;
    }

    if (rerolled) return this.rewrite(rerolled, message.id, model, rerollKey, { reroll: true });

    const target = this.findMergeTarget(model);
    if (target && model.kind === "damage") return this.mergeDamage(target, message.id, model);
    if (target && model.kind === "check") return this.rewrite(target, message.id, model, rerollKey);
    this.show(message.id, model, rerollKey);
  }

  handleDelete(message) {
    const record = this.byMessageId.get(message?.id);
    if (!record) return false;
    this.byMessageId.delete(message.id);
    record.messageIds.delete(message.id);
    const isPrimary = message.id === record.messageId;
    if (isPrimary && record.model.kind === "check" && record.rerollKey) {
      this.awaitingReroll.set(record.rerollKey, record);
      record.rerollTimer = window.setTimeout(() => {
        if (this.awaitingReroll.get(record.rerollKey) === record) this.awaitingReroll.delete(record.rerollKey);
        this.retire(record);
      }, REROLL_GRACE_MS);
      return true;
    }
    // A deleted merged damage roll leaves its card up; losing the card's own message takes the card down.
    if (isPrimary || !record.messageIds.size) this.retire(record);
    return true;
  }

  claimReroll(rerollKey) {
    const record = rerollKey ? this.awaitingReroll.get(rerollKey) : null;
    if (!record) return null;
    this.awaitingReroll.delete(rerollKey);
    window.clearTimeout(record.rerollTimer);
    this.touch(record, record.model.fx);
    return record;
  }

  /** A damage roll joins its attack's card; a check joins the cast card of the same spell. */
  findMergeTarget(model) {
    if (!model.originKey || !["damage", "check"].includes(model.kind)) return null;
    const now = Date.now();
    let best = null;
    for (const record of this.byMessageId.values()) {
      if (record.originKey !== model.originKey || record.exiting) continue;
      if (now - record.touchedAt > MERGE_WINDOW_MS) continue;
      if (model.kind === "check" && record.model.kind !== "cast") continue;
      if (model.kind === "damage" && !["check", "cast"].includes(record.model.kind)) continue;
      if (!best || record.touchedAt > best.touchedAt) best = record;
    }
    return best;
  }

  show(messageId, model, rerollKey) {
    const overlay = this.overlay;
    overlay.applySettings();
    const card = new RollCard(model, { label: localizeLabel, framer: portraitFramer });
    const record = {
      element: card.element,
      rollCard: card,
      messageId,
      messageIds: new Set([messageId]),
      model,
      originKey: model.originKey,
      rerollKey,
      touchedAt: 0,
      timeout: null,
      exiting: false
    };
    card.element.dataset.streamMessageId = messageId;
    overlay.streamMode.getChatRoot().append(card.element);
    overlay.cards.push(record);
    this.byMessageId.set(messageId, record);
    this.touch(record, model.fx);
    overlay.enforceMaxVisible();
    card.enter();
  }

  async rewrite(record, messageId, model, rerollKey, { reroll = false } = {}) {
    this.adopt(record, messageId);
    record.model = { ...model, damage: null };
    record.rerollKey = rerollKey ?? record.rerollKey;
    this.touch(record, model.fx);
    await record.rollCard.update(record.model, { reroll });
  }

  async mergeDamage(record, messageId, model) {
    this.adopt(record, messageId, { keepPrimary: true });
    this.touch(record, record.model.fx);
    await record.rollCard.addDamage(model.damage);
  }

  /** Points the card at a new message. A merged damage message keeps the card's own message primary. */
  adopt(record, messageId, { keepPrimary = false } = {}) {
    record.messageIds.add(messageId);
    this.byMessageId.set(messageId, record);
    if (!keepPrimary) {
      record.messageId = messageId;
      record.element.dataset.streamMessageId = messageId;
    }
  }

  /** Restarts the card's lifetime. Crit and fumble cards stay up longer. */
  touch(record, fx) {
    const settings = getChatSettings();
    const lifetime = Math.max(0, Number(settings.lifetimeMs) || 0);
    const multiplier = fx === "gold" || fx === "red" ? Math.max(1, Number(settings.critLifetimeMultiplier) || 1) : 1;
    record.touchedAt = Date.now();
    window.clearTimeout(record.timeout);
    record.timeout = window.setTimeout(() => this.retire(record), lifetime * multiplier);
  }

  /** Removes the card through the overlay, which owns the stack. */
  retire(record) {
    this.overlay.removeCard(record.element);
  }

  /** Called by the overlay once a roll card leaves the stack, however it left. */
  forget(record) {
    record.exiting = true;
    window.clearTimeout(record.timeout);
    window.clearTimeout(record.rerollTimer);
    for (const id of record.messageIds) {
      if (this.byMessageId.get(id) === record) this.byMessageId.delete(id);
    }
    if (record.rerollKey && this.awaitingReroll.get(record.rerollKey) === record) this.awaitingReroll.delete(record.rerollKey);
  }

  /**
   * Frames the art of everyone likely to roll before they do: the party, each player's character, the
   * current combatants and the world's default GM roll art. Uses the same art choice as the cards.
   */
  prescan() {
    const sources = [getDefaultRollArt().src];
    const add = (actor, token, preferToken) => sources.push(artFor(actor?.img, token?.texture?.src, preferToken));
    for (const user of game.users ?? []) if (user.character) add(user.character, user.character.prototypeToken, false);
    for (const member of game.actors?.party?.members ?? []) add(member, member.prototypeToken, false);
    for (const combatant of game.combat?.combatants ?? []) {
      const actor = combatant.actor;
      add(actor, combatant.token, !actor?.hasPlayerOwner);
    }
    portraitFramer.prescan(sources.filter(Boolean));
  }

  clear() {
    for (const record of this.awaitingReroll.values()) window.clearTimeout(record.rerollTimer);
    this.awaitingReroll.clear();
    this.byMessageId.clear();
  }
}

/** A check and its reroll share speaker, check type and statistic: PF2e copies the flags across. */
function rerollKeyOf(snapshot) {
  const pf2e = snapshot.raw.flags?.pf2e ?? {};
  const context = pf2e.context;
  if (!context?.type) return null;
  const speaker = snapshot.raw.speaker ?? {};
  return [speaker.token ?? speaker.actor ?? "", context.type, context.identifier ?? pf2e.modifierName ?? ""].join("|");
}

function localizeLabel(key) {
  const path = `GLUNIVERSE_STREAM.rollCard.${key}`;
  return game.i18n?.has?.(path) ? game.i18n.localize(path) : undefined;
}
