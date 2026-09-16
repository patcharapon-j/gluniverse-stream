import { MODULE_ID } from "./constants.js";

/** Resolves once Dice So Nice has finished showing a message's roll, so a card never spoils a roll still tumbling. */
export async function waitForDiceAnimation(message) {
  const hasRoll = Boolean(message?.rolls?.length) || Boolean(message?.isRoll);
  if (!hasRoll) return delay(120);
  const messageId = message?.id;
  const dice3d = game?.dice3d;
  try {
    if (messageId && typeof dice3d?.waitFor3DAnimationByMessageID === "function") {
      await Promise.race([dice3d.waitFor3DAnimationByMessageID(messageId), delay(10000)]);
      return;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Dice animation wait failed`, error);
  }
  if (messageId && game.modules?.get("dice-so-nice")?.active) {
    await waitForDiceSoNiceHook(messageId, 5000);
    return;
  }
  return delay(300);
}

function waitForDiceSoNiceHook(messageId, timeoutMs) {
  return new Promise(resolve => {
    let timeout;
    const done = () => {
      window.clearTimeout(timeout);
      Hooks.off("diceSoNiceRollComplete", hookId);
      resolve();
    };
    const hookId = Hooks.on("diceSoNiceRollComplete", completed => {
      const completedId = typeof completed === "string" ? completed : completed?.id ?? completed?.messageId;
      if (completedId !== messageId) return;
      done();
    });
    timeout = window.setTimeout(done, timeoutMs);
  });
}

function delay(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
}
