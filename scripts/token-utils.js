export function getCanvasToken(tokenId) {
  if (!tokenId) return null;
  const layer = canvas?.tokens;
  if (typeof layer?.get === "function") return layer.get(tokenId) ?? null;
  return layer?.placeables?.find(token => token.document?.id === tokenId || token.id === tokenId) ?? null;
}

export function visibleTokens() {
  return (canvas?.tokens?.placeables ?? []).filter(isVisibleToken);
}

/**
 * Hidden tokens are excluded even for GM clients, so a stream logged in as a GM never frames or
 * points at something the audience should not see.
 */
export function isVisibleToken(token) {
  return Boolean(token?.document && !token.document.hidden && token.visible !== false);
}

export function isPartyToken(token) {
  return Boolean(token?.actor?.hasPlayerOwner || hasPlayerOwner(token?.actor));
}

/**
 * Tokens the given token is currently targeting. Foundry stores targets per user, so a token's targets
 * are the targets of the users who control it: its actor's active player owners, or the active GMs
 * for tokens no active player owns.
 */
export function targetsOfToken(token) {
  const targets = new Map();
  for (const user of controllingUsers(token)) {
    for (const target of (user?.targets ?? [])) {
      const id = target?.document?.id;
      if (id && !targets.has(id)) targets.set(id, target);
    }
  }
  return [...targets.values()];
}

export function unionTokens(...groups) {
  const seen = new Set();
  return groups.flat().filter(token => {
    const id = token?.document?.id;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function controllingUsers(token) {
  const users = (game?.users?.contents ?? []).filter(user => user?.active);
  const actor = token?.actor;
  const owners = users.filter(user => !user.isGM && isActorOwner(actor, user));
  if (owners.length) return owners;
  return users.filter(user => user.isGM);
}

function hasPlayerOwner(actor) {
  if (!actor?.ownership) return false;
  const owner = CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3;
  return Object.entries(actor.ownership).some(([userId, level]) => userId !== "default" && level >= owner);
}

function isActorOwner(actor, user) {
  if (!actor || !user) return false;
  if (typeof actor.testUserPermission === "function") {
    return actor.testUserPermission(user, CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
  }
  const level = actor.ownership?.[user.id];
  return Number(level) >= (CONST.DOCUMENT_OWNERSHIP_LEVELS?.OWNER ?? 3);
}
