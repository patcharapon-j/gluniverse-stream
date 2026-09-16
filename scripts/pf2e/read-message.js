/**
 * PF2e chat message -> roll card model.
 *
 * Pure: no `game`, no DOM. It reads the plain snapshot built by `snapshot.js` (the same shape the
 * fixtures in tests/fixtures/pf2e were captured in) and decides what, if anything, the stream shows.
 */

import { isFocus } from "../framing/focus-math.js";

export const DEGREES = ["criticalFailure", "failure", "success", "criticalSuccess"];

const CHECK_TYPES = new Set([
  "attack-roll",
  "skill-check",
  "saving-throw",
  "perception-check",
  "flat-check",
  "initiative",
  "counteract-check",
  "check"
]);

const DEFAULT_TOKEN_ICON = /(^|\/)(icons\/svg\/mystery-man\.svg|systems\/pf2e\/icons\/default-icons\/)/;

/**
 * @param {{raw: object, derived: object}} snapshot
 * @returns {RollCardModel|null} null when the stream must not show this message.
 */
export function readMessage(snapshot) {
  const raw = snapshot?.raw;
  const derived = snapshot?.derived;
  if (!raw || !derived) return null;

  const visibility = visibilityOf(raw, derived);
  if (!visibility) return null;

  const pf2e = raw.flags?.pf2e ?? {};
  const context = pf2e.context ?? null;
  const kind = kindOf(pf2e, context, derived);
  if (!kind) return null;

  const base = {
    id: raw._id,
    kind,
    originKey: originKeyOf(pf2e.origin),
    isReroll: !!derived.isReroll,
    visibility,
    actor: actorOf(derived),
    player: derived.authorIsGM ? null : { name: derived.authorName ?? "" },
    target: isSelfTarget(raw, context) ? null : targetOf(derived),
    action: null,
    roll: null,
    spell: null,
    damage: null,
    fx: null
  };

  if (kind === "check") return { ...base, ...readCheck(raw, context, derived) };
  if (kind === "damage") return { ...base, ...readDamage(raw, derived) };
  if (kind === "cast") return { ...base, ...readCast(pf2e, derived) };
  const cost = derived.item?.actionCost ?? null;
  return {
    ...base,
    action: {
      label: derived.item?.name ?? headingText(raw.content) ?? "",
      sub: null,
      map: 0,
      cost: cost ? { type: cost.type ?? "action", value: cost.value ?? null } : null
    }
  };
}

/** "public", "ownBlind" (a player's own blind roll), or null for anything the stream must not show. */
export function visibilityOf(raw, derived) {
  const whispered = (raw.whisper?.length ?? 0) > 0;
  if (raw.blind) return derived.authorIsGM ? null : "ownBlind";
  if (whispered) return null;
  return "public";
}

function kindOf(pf2e, context, derived) {
  const type = context?.type;
  if (type && CHECK_TYPES.has(type)) return derived.rollCount > 0 ? "check" : null;
  if (type === "damage-roll") return derived.rollCount > 0 ? "damage" : null;
  if (type === "spell-cast" || pf2e.casting) return "cast";
  if (!type && pf2e.origin && derived.rollCount === 0 && /^(action|feat)$/.test(pf2e.origin.type ?? "")) return "action";
  return null;
}

function readCheck(raw, context, derived) {
  const roll = derived.rolls[0] ?? {};
  const natural = naturalOf(roll);
  const dcValue = Number.isFinite(context.dc?.value) ? context.dc.value : null;
  const degree = dcValue === null ? null : degreeIndex(context.outcome ?? roll.degreeOfSuccess);
  const heading = headingText(raw.flavor);
  const isSpellAttack = context.type === "attack-roll" && derived.item?.type === "spell";
  const map = mapOf(context.options);
  return {
    action: {
      label: isSpellAttack ? derived.item.name : heading ?? context.type,
      sub: isSpellAttack ? heading : null,
      map
    },
    roll: {
      natural,
      total: roll.total ?? null,
      dc: dcValue,
      dcVisible: dcValue !== null && !derived.authorIsGM,
      degree
    },
    fx: fxOf(degree, natural)
  };
}

function readDamage(raw, derived) {
  const roll = derived.rolls[0] ?? {};
  const parts = (roll.instances ?? [])
    .filter((i) => !i.kinds || i.kinds.includes("damage"))
    .map((i) => ({ type: i.type ?? "untyped", amount: i.total ?? 0, persistent: !!i.persistent }));
  const crit = roll.degreeOfSuccess === 3;
  return {
    action: { label: headingText(raw.flavor) ?? derived.item?.name ?? "", sub: null, map: 0 },
    damage: { total: roll.total ?? 0, parts, crit },
    fx: crit ? "pop" : null
  };
}

function readCast(pf2e, derived) {
  const item = derived.item ?? {};
  const defense = item.defense ?? {};
  const save = defense.save ?? null;
  const isAttack = !save && defense.passive?.statistic === "ac";
  return {
    action: { label: item.name ?? "", sub: null, map: 0 },
    spell: {
      name: item.name ?? "",
      tradition: pf2e.casting?.tradition ?? null,
      rank: item.rank ?? null,
      isCantrip: !!item.isCantrip,
      dc: save ? item.spellDC ?? null : null,
      save: save ? { statistic: save.statistic, basic: !!save.basic } : null,
      attackBonus: isAttack ? item.spellAttack ?? null : null
    }
  };
}

/** The d20 that counted. Post-roll options are not used: a reroll copies them from the original roll. */
export function naturalOf(roll) {
  const results = roll?.d20Results;
  if (!Array.isArray(results)) return null;
  const active = results.filter((r) => r.active !== false);
  return active.length ? active[active.length - 1].result : null;
}

export function degreeIndex(value) {
  if (typeof value === "number") return value >= 0 && value <= 3 ? value : null;
  const index = DEGREES.indexOf(value);
  return index === -1 ? null : index;
}

/** Cracks: gold on a critical success, red on a critical failure. With no DC, a natural 20 or 1 decides. */
export function fxOf(degree, natural) {
  if (degree === 3) return "gold";
  if (degree === 0) return "red";
  if (degree === null && natural === 20) return "gold";
  if (degree === null && natural === 1) return "red";
  return null;
}

function mapOf(options = []) {
  const option = options.find((o) => o.startsWith("map:increases:"));
  return option ? Number(option.split(":")[2]) || 0 : 0;
}

/** The origin item's UUID (it embeds the actor) is the merge key: damage joins the card whose roll came from the same weapon or spell. */
function originKeyOf(origin) {
  if (!origin?.uuid) return null;
  return origin.uuid;
}

function actorOf(derived) {
  const actor = derived.actor ?? {};
  const token = derived.token ?? {};
  const isNpc = !!derived.authorIsGM && !actor.hasPlayerOwner;
  const hiddenName = isNpc && !!derived.nameVisibilitySetting && token.playersCanSeeName === false;
  const tokenImg = usable(token.textureSrc);
  const own = artFor(actor.img, token.textureSrc, isNpc);
  // A GM roll with nothing of its own to show falls back to the world's default roll art.
  const fallback = own ? null : defaultArtOf(derived.authorIsGM ? derived.defaultArt : null);
  const img = own ?? fallback?.src ?? null;
  return {
    name: hiddenName ? null : token.name ?? actor.name ?? "",
    isNpc,
    img,
    imgKind: (img ? img === tokenImg : isNpc) ? "token" : "portrait",
    focus: fallback ? fallback.focus : focusFor(actor.focusOverrides, img)
  };
}

/** The world's picture for GM rolls with no art, with the framing the GM set for it. */
function defaultArtOf(defaultArt) {
  const src = typeof defaultArt?.src === "string" ? defaultArt.src.trim() : "";
  if (!src) return null;
  const focus = defaultArt.focus;
  return { src, focus: isFocus(focus) ? { x: focus.x, y: focus.y, w: focus.w } : null };
}

/** A GM's framing for this exact image, if one was set. */
function focusFor(overrides, img) {
  if (!img || !Array.isArray(overrides)) return null;
  const match = overrides.find(o => o?.src === img && isFocus(o));
  return match ? { x: match.x, y: match.y, w: match.w } : null;
}

/** PF2e records the roller as the target of their own saves and checks. */
function isSelfTarget(raw, context) {
  const token = context?.target?.token;
  const own = raw.speaker?.token;
  return !!token && !!own && token.endsWith(`Token.${own}`);
}

function targetOf(derived) {
  const target = derived.target;
  if (!target) return null;
  const hidden = !!derived.nameVisibilitySetting && target.playersCanSeeName === false;
  return { name: hidden ? null : target.tokenName ?? target.actorName ?? null };
}

/** The art a card shows: creatures lead with their token, characters with their portrait. Default icons never count. */
export function artFor(actorImg, tokenImg, preferToken) {
  const portrait = usable(actorImg);
  const token = usable(tokenImg);
  return preferToken ? token ?? portrait : portrait ?? token;
}

function usable(src) {
  return src && !DEFAULT_TOKEN_ICON.test(src) ? src : null;
}

/** Text of the first heading in PF2e's flavor or content HTML ("Reflex Saving Throw", "Melee Strike: Club"). */
export function headingText(html) {
  if (typeof html !== "string") return null;
  const match = html.match(/<h[34][^>]*>([\s\S]*?)<\/h[34]>/i);
  if (!match) return null;
  const inner = match[1].replace(/<span[^>]*(?:pf2-icon|action-glyph)[^>]*>[\s\S]*?<\/span>/gi, " ");
  const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim();
  return text || null;
}

function decodeEntities(text) {
  return text.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m, e) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " })[e]);
}

/**
 * @typedef {object} RollCardModel
 * @property {string} id
 * @property {"check"|"damage"|"cast"|"action"} kind
 * @property {string|null} originKey
 * @property {boolean} isReroll
 * @property {"public"|"ownBlind"} visibility
 * @property {{name: string|null, isNpc: boolean, img: string|null, imgKind: "token"|"portrait", focus: {x: number, y: number, w: number}|null}} actor
 * @property {{name: string}|null} player
 * @property {{name: string|null}|null} target
 * @property {{label: string, sub: string|null, map: number, cost?: {type: string, value: number|null}|null}|null} action
 * @property {{natural: number|null, total: number|null, dc: number|null, dcVisible: boolean, degree: 0|1|2|3|null}|null} roll
 * @property {{name: string, tradition: string|null, rank: number|null, isCantrip: boolean, dc: number|null, save: {statistic: string, basic: boolean}|null, attackBonus: number|null}|null} spell
 * @property {{total: number, parts: {type: string, amount: number, persistent: boolean}[], crit: boolean}|null} damage
 * @property {"gold"|"red"|"pop"|null} fx
 */
