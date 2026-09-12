import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

test("turn changes ignore carried user targets and accept fresh targeting", () => {
  const hooks = new Map();
  const frames = [];
  const token = id => ({ document: { id, disposition: 1 }, visible: true });
  const first = token("first");
  const second = token("second");
  const target = token("target");
  const gm = { id: "gm", active: true, isGM: true, targets: new Set([target]) };
  const combat = { id: "combat", started: true, round: 1, turn: 0, combatant: { id: "a", token: first } };
  const context = vm.createContext({
    console, Map, Set, JSON,
    game: { users: { contents: [gm] } },
    canvas: { ready: true, scene: { id: "scene" } },
    Hooks: { on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) },
    requestAnimationFrame: fn => frames.push(fn),
    getActiveSceneCombat: () => combat,
    getActiveCombatant: c => c.combatant,
    getCombatantToken: c => c.token,
    getTargetingSettings: () => ({ enabled: true }),
    getSetting: () => true,
    MODULE_ID: "test", TARGET_LINE_VISIBILITY: { streamOnly: "stream", gmAndStream: "gm" },
    CONST: { TOKEN_DISPOSITIONS: { FRIENDLY: 1, HOSTILE: -1 } },
    prefersCalmMotion: () => true,
    onCanvasFrame: () => () => {},
    TargetLine: class {
      constructor(options) { Object.assign(this, options); }
      show() { this.leaving = false; }
      hide() { this.leaving = true; }
      setStyle() {}
    }
  });
  const utils = readFileSync(new URL("../scripts/token-utils.js", import.meta.url), "utf8");
  const controller = readFileSync(new URL("../scripts/targeting/target-lines.js", import.meta.url), "utf8");
  vm.runInContext(utils.replaceAll("export ", "") + "\n" +
    controller.replace(/^import .*;\r?\n/gm, "").replace("export class", "class") +
    "\nglobalThis.controller = new TargetLineController();", context);
  const instance = context.controller;
  instance.registerHooks();
  instance.layer = {};
  const flush = () => { while (frames.length) frames.shift()(); };
  const emit = (name, ...args) => { for (const fn of hooks.get(name) ?? []) fn(...args); };
  flush();
  assert.equal(instance.lines.get("first>target").leaving, false);

  combat.turn = 1;
  combat.combatant = { id: "b", token: second };
  emit("updateCombat", combat, { turn: 1 });
  flush();
  assert.equal(instance.lines.get("first>target").leaving, true);
  assert.equal(instance.lines.has("second>target"), false);
  emit("sightRefresh");
  flush();
  assert.equal(instance.lines.has("second>target"), false);

  gm.targets.delete(target);
  emit("targetToken", gm, target, false);
  gm.targets.add(target);
  emit("targetToken", gm, target, true);
  flush();
  assert.equal(instance.lines.get("second>target").leaving, false);

  // A new round also invalidates targets if the same combatant remains active.
  combat.round++;
  emit("updateCombat", combat, { round: 2 });
  flush();
  assert.equal(instance.lines.get("second>target").leaving, true);

  // Targeting between a turn update and its animation frame must not be discarded.
  combat.turn = 0;
  combat.combatant = { id: "a", token: first };
  emit("updateCombat", combat, { turn: 0 });
  emit("targetToken", gm, target, true);
  flush();
  assert.equal(instance.lines.get("first>target").leaving, false);
  assert.equal(gm.targets.has(target), true, "display filtering must preserve Foundry targets");
});
