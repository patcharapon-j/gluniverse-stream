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
export function targetsOfToken(token, includeTarget = () => true) {
  const targets = new Map();
  for (const user of controllingUsers(token)) {
    for (const target of (user?.targets ?? [])) {
      const id = target?.document?.id;
      if (id && !targets.has(id) && includeTarget(user, target)) targets.set(id, target);
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

/**
 * The active non-GM owners of a token's actor. When there are any, they are the token's controlling users
 * and it is a player-controlled token; when there are none, the active GMs control it.
 */
export function playerControllingUsers(token) {
  const actor = token?.actor;
  return activeUsers().filter(user => !user.isGM && isActorOwner(actor, user));
}

/**
 * The player or players a token's turn belongs to, for telling one player's turns from another's: the active
 * non-GM users whose assigned character is the token's actor, or, when nobody has it assigned, its active non-GM
 * owners. Assignment comes first because many tables give every player ownership of every character; a
 * companion or summon nobody has assigned belongs to whoever owns it. A GM-controlled token has none.
 *
 * This is not the controlling-user rule: targets and colours still come from `targetsOfToken`.
 */
export function turnPlayers(token) {
  const actor = token?.actor;
  if (!actor) return [];
  const players = activeUsers().filter(user => !user.isGM);
  const assigned = players.filter(user => isAssignedCharacter(user, actor));
  if (assigned.length) return assigned;
  return players.filter(user => isActorOwner(actor, user));
}

function controllingUsers(token) {
  const owners = playerControllingUsers(token);
  if (owners.length) return owners;
  return activeUsers().filter(user => user.isGM);
}

/**
 * Whether `actor` is the user's assigned character. An unlinked token's synthetic actor is matched through its
 * token's base actor id as well as its own.
 */
function isAssignedCharacter(user, actor) {
  const characterId = user?.character?.id;
  if (!characterId) return false;
  return characterId === actor.id || characterId === actor.token?.actorId;
}

function activeUsers() {
  return (game?.users?.contents ?? []).filter(user => user?.active);
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
