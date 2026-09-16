/**
 * Dev tool: capture PF2e chat messages as JSON fixtures for tests/pf2e-read-message.test.mjs.
 *
 * Paste into the browser console (F12) of a PF2e 8.x world.
 *
 *   On the GM client, after making the rolls:
 *     GLUStreamFixtures.capture(15)            // saves the last 15 messages to a JSON download
 *
 *   On the stream client (logged in as the stream user):
 *     GLUStreamFixtures.probe(15)              // prints what this non-GM client can see of each message
 *
 * Not loaded by the module.
 */
(() => {
  const summarizeRoll = (roll) => {
    const d20 = roll.dice?.find((die) => die.faces === 20);
    return {
      className: roll.constructor?.name ?? null,
      formula: roll.formula,
      total: roll.total ?? null,
      d20Results: d20 ? d20.results.map((r) => ({ result: r.result, active: r.active !== false })) : null,
      degreeOfSuccess: roll.options?.degreeOfSuccess ?? null,
      instances: Array.isArray(roll.instances)
        ? roll.instances.map((i) => ({
            type: i.type ?? null,
            total: i.total ?? null,
            persistent: !!i.persistent,
            critRule: i.critRule ?? null,
            kinds: i.kinds ? [...i.kinds] : null
          }))
        : null
    };
  };

  /** The world's fallback picture for GM rolls with no art, as the module's settings hold it. */
  const defaultRollArt = () => {
    try {
      return game.settings.get("gluniverse-stream", "defaultRollArt") ?? null;
    } catch (error) {
      return null;
    }
  };

  const snapshot = (message) => {
    const actor = message.actor ?? null;
    const token = message.token ?? null;
    const target = message.target ?? null;
    let item = null;
    try {
      item = message.item ?? null;
    } catch (error) {
      item = { error: String(error) };
    }
    return {
      raw: message.toObject(),
      derived: {
        viewerIsGM: game.user.isGM,
        authorName: message.author?.name ?? null,
        authorIsGM: !!message.author?.isGM,
        isCheckRoll: !!message.isCheckRoll,
        isDamageRoll: !!message.isDamageRoll,
        isReroll: !!message.isReroll,
        isContentVisible: !!message.isContentVisible,
        visible: !!message.visible,
        rollCount: message.rolls?.length ?? 0,
        rolls: (message.rolls ?? []).map(summarizeRoll),
        actor: actor && {
          name: actor.name,
          type: actor.type,
          img: actor.img,
          hasPlayerOwner: !!actor.hasPlayerOwner
        },
        token: token && {
          name: token.name,
          textureSrc: token.texture?.src ?? null,
          playersCanSeeName: token.playersCanSeeName ?? null
        },
        target: target && {
          actorName: target.actor?.name ?? null,
          tokenName: target.token?.name ?? null,
          playersCanSeeName: target.token?.playersCanSeeName ?? null
        },
        item: item && !item.error
          ? {
              name: item.name,
              type: item.type,
              rank: item.rank ?? null,
              isCantrip: item.isCantrip ?? null,
              traditions: item.system?.traits?.traditions ?? null,
              defense: item.system?.defense ?? null,
              actionCost: item.actionCost ?? null,
              spellDC: item.spellcasting?.statistic?.dc?.value ?? null,
              spellAttack: item.spellcasting?.statistic?.check?.mod ?? null
            }
          : item,
        defaultArt: defaultRollArt(),
        nameVisibilitySetting: game.pf2e?.settings?.tokens?.nameVisibility ?? null
      }
    };
  };

  const lastMessages = (count) => game.messages.contents.slice(-count);

  window.GLUStreamFixtures = {
    snapshot,

    capture(count = 15) {
      const data = {
        capturedAt: new Date().toISOString(),
        foundry: game.version,
        system: `${game.system.id} ${game.system.version}`,
        messages: lastMessages(count).map(snapshot)
      };
      const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
      save(JSON.stringify(data, null, 2), "application/json", `pf2e-fixtures-${Date.now()}.json`);
      return `${data.messages.length} messages saved`;
    },

    probe(count = 15) {
      const rows = lastMessages(count).map((m) => ({
        id: m.id,
        type: m.flags?.pf2e?.context?.type ?? "(none)",
        author: m.author?.name,
        blind: m.blind,
        whisper: m.whisper?.length ?? 0,
        rollCount: m.rolls?.length ?? 0,
        total: m.rolls?.[0]?.total ?? null,
        contentVisible: m.isContentVisible,
        outcome: m.flags?.pf2e?.context?.outcome ?? null
      }));
      console.table(rows);
      return rows;
    }
  };

  return "GLUStreamFixtures ready: capture(n) on the GM client, probe(n) on the stream client";
})();
