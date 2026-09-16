/**
 * Live ChatMessagePF2e -> the plain snapshot `readMessage` reads.
 *
 * Keep in step with tools/capture-pf2e-fixtures.js: the fixtures were captured in this shape, so a field
 * added here must be added there (and recaptured) before the reader relies on it.
 */

export function snapshotMessage(message) {
  const source = message._source ?? message.toObject?.() ?? {};
  return {
    raw: {
      _id: message.id,
      blind: !!message.blind,
      whisper: [...(message.whisper ?? [])],
      author: message.author?.id ?? null,
      speaker: { ...(message.speaker ?? {}) },
      flavor: message.flavor ?? "",
      content: message.content ?? "",
      flags: source.flags ?? {}
    },
    derived: {
      authorName: message.author?.name ?? null,
      authorIsGM: !!message.author?.isGM,
      isReroll: !!message.isReroll,
      rollCount: message.rolls?.length ?? 0,
      rolls: (message.rolls ?? []).map(summarizeRoll),
      actor: actorOf(message.actor),
      token: tokenOf(message.token),
      target: targetOf(message),
      item: itemOf(message),
      nameVisibilitySetting: !!game.pf2e?.settings?.tokens?.nameVisibility
    }
  };
}

function summarizeRoll(roll) {
  const d20 = roll.dice?.find((die) => die.faces === 20);
  return {
    total: roll.total ?? null,
    d20Results: d20 ? d20.results.map((r) => ({ result: r.result, active: r.active !== false })) : null,
    degreeOfSuccess: roll.options?.degreeOfSuccess ?? null,
    instances: Array.isArray(roll.instances)
      ? roll.instances.map((i) => ({
          type: i.type ?? null,
          total: i.total ?? null,
          persistent: !!i.persistent,
          kinds: i.kinds ? [...i.kinds] : null
        }))
      : null
  };
}

function actorOf(actor) {
  if (!actor) return null;
  return { name: actor.name, type: actor.type, img: actor.img, hasPlayerOwner: !!actor.hasPlayerOwner };
}

function tokenOf(token) {
  if (!token) return null;
  return { name: token.name, textureSrc: token.texture?.src ?? null, playersCanSeeName: token.playersCanSeeName ?? null };
}

function targetOf(message) {
  let target = null;
  try {
    target = message.target;
  } catch {
    return null;
  }
  if (!target) return null;
  return {
    actorName: target.actor?.name ?? null,
    tokenName: target.token?.name ?? null,
    playersCanSeeName: target.token?.playersCanSeeName ?? null
  };
}

function itemOf(message) {
  let item = null;
  try {
    item = message.item;
  } catch {
    return null;
  }
  if (!item) return null;
  return {
    name: item.name,
    type: item.type,
    rank: item.rank ?? null,
    isCantrip: item.isCantrip ?? null,
    defense: item.system?.defense ?? null,
    actionCost: item.actionCost ?? null,
    spellDC: item.spellcasting?.statistic?.dc?.value ?? null,
    spellAttack: item.spellcasting?.statistic?.check?.mod ?? null
  };
}
