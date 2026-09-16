import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { readMessage, headingText, fxOf, visibilityOf } from "../scripts/pf2e/read-message.js";

const load = name => JSON.parse(readFileSync(new URL(`./fixtures/pf2e/${name}`, import.meta.url), "utf8"));
/** Captured on the GM client and on a non-GM client (the stream's point of view). */
const captures = { gm: load("capture-gm.json"), player: load("capture-player.json") };

for (const [viewer, capture] of Object.entries(captures)) {
  const byLabel = label => {
    const found = capture.messages.filter(m => m.label === label);
    assert.ok(found.length, `fixture ${label} missing`);
    return found;
  };
  const read = label => readMessage(byLabel(label)[0]);

  describe(`PF2e 8.4 fixtures read on the ${viewer} client`, () => {
    test("a plain hit shows total, natural, DC and success with no cracks", () => {
      const card = read("strike-map5");
      assert.equal(card.kind, "check");
      assert.equal(card.visibility, "public");
      assert.deepEqual(card.player, { name: "Player2" });
      assert.equal(card.actor.name, "Kyra");
      assert.equal(card.actor.imgKind, "portrait");
      assert.equal(card.actor.img, "systems/pf2e/icons/iconics/portraits/kyra.webp");
      assert.equal(card.target.name, "Oleg");
      assert.equal(card.action.label, "Melee Strike: +1 Scimitar");
      assert.equal(card.action.map, 1);
      assert.deepEqual(card.roll, { natural: 12, total: 15, dc: 12, dcVisible: true, degree: 2 });
      assert.equal(card.fx, null);
      assert.equal(card.originKey, "Actor.MjkJCqGyiVNWlcLU.Item.Kf9Fu77b4kHAwSUm");
    });

    test("a natural 20 critical success cracks gold", () => {
      const card = read("strike-crit");
      assert.equal(card.roll.natural, 20);
      assert.equal(card.roll.degree, 3);
      assert.equal(card.fx, "gold");
    });

    test("a critical success without a natural 20 still cracks gold", () => {
      const card = read("strike-map0-hit");
      assert.equal(card.roll.natural, 14);
      assert.equal(card.roll.degree, 3);
      assert.equal(card.fx, "gold");
    });

    test("a miss is a failure with no cracks", () => {
      const card = read("strike-miss");
      assert.equal(card.roll.degree, 1);
      assert.equal(card.fx, null);
    });

    test("a natural 1 critical failure on a save cracks red", () => {
      const card = read("save-reflex-dc-fumble");
      assert.equal(card.action.label, "Reflex Saving Throw");
      assert.equal(card.target, null);
      assert.deepEqual(card.roll, { natural: 1, total: 7, dc: 22, dcVisible: true, degree: 0 });
      assert.equal(card.fx, "red");
      assert.equal(card.originKey, null);
    });

    test("a roll with no DC has no degree, and a natural 20 still cracks gold", () => {
      const plain = read("skill-nodc");
      assert.equal(plain.action.label, "Religion Check");
      assert.deepEqual(plain.roll, { natural: 9, total: 20, dc: null, dcVisible: false, degree: null });
      assert.equal(plain.fx, null);
      const twenty = read("skill-nodc-nat20");
      assert.equal(twenty.roll.degree, null);
      assert.equal(twenty.fx, "gold");
    });

    test("damage carries typed parts, the crit flag and the attack's origin key", () => {
      const hit = read("strike-map0-damage");
      assert.equal(hit.kind, "damage");
      assert.equal(hit.originKey, "Actor.MjkJCqGyiVNWlcLU.Item.Kf9Fu77b4kHAwSUm");
      assert.equal(hit.damage.crit, false);
      assert.equal(hit.damage.total, 4);
      assert.deepEqual(hit.damage.parts, [{ type: "slashing", amount: 4, persistent: false }]);
      assert.equal(hit.fx, null);
      const crit = read("strike-crit-damage");
      assert.equal(crit.damage.crit, true);
      assert.equal(crit.damage.total, 12);
      assert.equal(crit.fx, "pop");
      assert.equal(crit.action.label, "Damage Roll: +1 Scimitar (Critical Hit)");
    });

    test("an attack spell chains cast, attack and damage on one origin key", () => {
      const [cast, sibling] = byLabel("spell-attack-cast");
      const castCard = readMessage(cast);
      assert.equal(castCard.kind, "cast");
      assert.deepEqual(castCard.spell, {
        name: "Fire Ray", tradition: "divine", rank: 2, isCantrip: false, dc: null, save: null, attackBonus: 9
      });
      assert.equal(readMessage(sibling), null, "another module's untyped follow-up message is hidden");
      const attack = read("spell-attack-roll");
      assert.equal(attack.action.label, "Fire Ray");
      assert.equal(attack.action.sub, "Divine Spell Attack");
      assert.equal(attack.fx, "gold");
      const damage = read("spell-attack-damage");
      assert.equal(castCard.originKey, attack.originKey);
      assert.equal(attack.originKey, damage.originKey);
    });

    test("a save spell shows its DC and save type", () => {
      const card = read("spell-save-cast");
      assert.deepEqual(card.spell, {
        name: "Daze", tradition: "divine", rank: 2, isCantrip: true, dc: 19,
        save: { statistic: "will", basic: true }, attackBonus: null
      });
      assert.equal(card.originKey, read("spell-save-damage").originKey);
    });

    test("a player's own blind roll is shown with its result, other secret rolls are hidden", () => {
      const blind = read("blind-own-roll");
      assert.equal(blind.visibility, "ownBlind");
      assert.equal(blind.roll.total, 18);
      assert.equal(blind.roll.natural, 17);
      assert.equal(read("gm-secret-blind"), null);
      assert.equal(read("gm-whisper"), null);
    });

    test("a public GM roll becomes the NPC variant with its DC hidden", () => {
      const card = read("gm-npc-strike");
      assert.equal(card.player, null);
      assert.equal(card.actor.isNpc, true);
      assert.equal(card.actor.imgKind, "token");
      assert.equal(card.actor.img, null, "the default NPC icon is not a portrait");
      assert.equal(card.actor.name, "Ambush Scout", "name visibility is off in this world");
      assert.equal(card.target.name, "Kyra");
      assert.equal(card.roll.dc, 19);
      assert.equal(card.roll.dcVisible, false);
      assert.equal(read("gm-npc-damage").originKey, card.originKey);
    });

    test("a hero point reroll reads the new natural, not the copied post-roll option", () => {
      const card = read("reroll-heropoint");
      assert.equal(card.isReroll, true);
      assert.equal(card.roll.natural, 20);
      assert.equal(card.roll.degree, 3);
      assert.equal(card.fx, "gold");
    });

    test("initiative is a check without a DC", () => {
      const card = read("initiative");
      assert.equal(card.kind, "check");
      assert.equal(card.action.label, "Initiative: Perception");
      assert.equal(card.roll.degree, null);
    });

    test("an action posted from a sheet is an action card named from its content", () => {
      const card = read("action-post");
      assert.equal(card.kind, "action");
      assert.equal(card.action.label, "Hide");
      assert.equal(card.roll, null);
    });
  });
}

describe("rules", () => {
  test("hidden names apply when PF2e name visibility is on and the token hides its name", () => {
    const snapshot = structuredClone(captures.gm.messages.find(m => m.label === "gm-npc-strike"));
    snapshot.derived.nameVisibilitySetting = true;
    const card = readMessage(snapshot);
    assert.equal(card.actor.name, null);
    assert.equal(card.target.name, "Kyra", "a player-owned target keeps its name");
  });

  test("visibility: public, own blind, and everything else hidden", () => {
    assert.equal(visibilityOf({ blind: false, whisper: [] }, { authorIsGM: true }), "public");
    assert.equal(visibilityOf({ blind: true, whisper: ["gm"] }, { authorIsGM: false }), "ownBlind");
    assert.equal(visibilityOf({ blind: true, whisper: ["gm"] }, { authorIsGM: true }), null);
    assert.equal(visibilityOf({ blind: false, whisper: ["gm"] }, { authorIsGM: false }), null);
  });

  test("fx: degree first, natural only without a DC", () => {
    assert.equal(fxOf(3, 5), "gold");
    assert.equal(fxOf(0, 15), "red");
    assert.equal(fxOf(2, 20), null, "a natural 20 that only reached success does not crack");
    assert.equal(fxOf(null, 20), "gold");
    assert.equal(fxOf(null, 1), "red");
    assert.equal(fxOf(null, 12), null);
  });

  test("headingText strips markup and action glyphs", () => {
    assert.equal(headingText('<h4 class="action"><strong>Take Cover</strong> <span class="pf2-icon larger">1</span></h4>'), "Take Cover");
    assert.equal(headingText("<p>no heading</p>"), null);
    assert.equal(headingText(null), null);
  });
});
