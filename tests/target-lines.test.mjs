import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
/** Module source as a plain script: single-line imports dropped (the sandbox supplies them), exports unwrapped. */
const asScript = code => code.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

/**
 * A TargetLineController wired to fake Foundry globals, a fake TargetLine that logs show/hide, a queued
 * requestAnimationFrame and a fake anime.js timer clock.
 */
function createHarness({ users, calm = true }) {
  const hooks = new Map();
  const frames = [];
  const tokens = new Map();
  const clock = { now: 0, timers: [] };
  const log = [];
  const combat = { id: "combat", started: true, round: 1, turn: 0, combatant: null };

  class FakeTargetLine {
    shown = false;
    leaving = false;
    constructor(options) {
      Object.assign(this, options);
      this.key = `${options.sourceId}>${options.targetId}`;
    }
    show() {
      if (this.shown && !this.leaving) return;
      this.shown = true;
      this.leaving = false;
      log.push({ event: "show", key: this.key, at: clock.now });
    }
    hide() {
      if (this.leaving) return;
      this.leaving = true;
      log.push({ event: "hide", key: this.key, at: clock.now });
    }
    destroy() {
      this.destroyed = true;
      this.onGone?.(this);
    }
    setStyle() {}
  }

  const context = vm.createContext({
    console, Map, Set, JSON,
    game: { users: { contents: users } },
    canvas: { ready: true, scene: { id: "scene" }, tokens: { get: id => tokens.get(id) } },
    Hooks: { on: (name, fn) => hooks.set(name, [...(hooks.get(name) ?? []), fn]) },
    requestAnimationFrame: fn => frames.push(fn),
    getActiveSceneCombat: () => combat,
    getActiveCombatant: c => c.combatant,
    getCombatantToken: c => c?.token ?? null,
    getTargetingSettings: () => ({ enabled: true }),
    getSetting: () => true,
    isConfiguredStreamUser: () => false,
    CONST: { TOKEN_DISPOSITIONS: { FRIENDLY: 1, HOSTILE: -1 } },
    prefersCalmMotion: () => calm,
    onCanvasFrame: () => () => {},
    createTimer: ({ duration = 0, delay = 0, onComplete }) => {
      const timer = {
        duration: delay + duration,
        at: clock.now + delay + duration,
        onComplete,
        cancelled: false,
        cancel() {
          this.cancelled = true;
          return this;
        }
      };
      clock.timers.push(timer);
      return timer;
    },
    TargetLine: FakeTargetLine
  });
  vm.runInContext([
    asScript(read("../scripts/constants.js")),
    asScript(read("../scripts/token-utils.js")),
    asScript(read("../scripts/targeting/target-lines.js")),
    "globalThis.controller = new TargetLineController();",
    "globalThis.TARGET_LINE_MOTION = TARGET_LINE_MOTION;"
  ].join("\n"), context);

  const controller = context.controller;

  const flush = () => {
    while (frames.length) frames.shift()();
  };
  const emit = (name, ...args) => {
    for (const fn of hooks.get(name) ?? []) fn(...args);
  };
  const harness = {
    controller,
    combat,
    clock,
    log,
    motion: context.TARGET_LINE_MOTION,
    flush,
    emit,
    /** Load the controller with `token` already the active combatant, as on a fresh page load. */
    start(token) {
      combat.combatant = { id: `c-${token.document.id}`, token };
      controller.registerHooks();
      controller.layer = {
        destroyed: false,
        destroy() {
          this.destroyed = true;
        }
      };
      flush();
    },
    /** A token whose actor is owned by the given users (none: a GM-controlled NPC). */
    token(id, owners = []) {
      const actor = owners.length
        ? { ownership: Object.fromEntries(owners.map(user => [user.id, 3])) }
        : null;
      const token = { document: { id, disposition: 1 }, visible: true, actor };
      tokens.set(id, token);
      return token;
    },
    /** Make `token` the active combatant and fire the combat update, as Foundry does on a turn change. */
    turn(token, { round = combat.round, turn = combat.turn + 1 } = {}) {
      combat.round = round;
      combat.turn = turn;
      combat.combatant = { id: `c-${token.document.id}`, token };
      emit("updateCombat", combat, { round, turn });
    },
    target(user, token) {
      user.targets.add(token);
      emit("targetToken", user, token, true);
    },
    /** Run the fake clock forward, firing due timers and the frames they queue. */
    advance(ms) {
      const end = clock.now + ms;
      for (;;) {
        const due = clock.timers
          .filter(timer => !timer.cancelled && !timer.fired && timer.at <= end)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        clock.now = due.at;
        due.fired = true;
        due.onComplete?.(due);
        flush();
      }
      clock.now = end;
      flush();
    },
    shown(key) {
      const line = controller.lines.get(key);
      return Boolean(line?.shown && !line.leaving);
    },
    leaving(key) {
      return controller.lines.get(key)?.leaving === true;
    },
    liveTimers() {
      return clock.timers.filter(timer => !timer.cancelled && !timer.fired);
    },
    events(key) {
      return log.filter(entry => entry.key === key);
    }
  };
  return harness;
}

const gmUser = (targets = []) => ({ id: "gm", active: true, isGM: true, targets: new Set(targets) });
const player = (id, targets = []) => ({ id, active: true, isGM: false, targets: new Set(targets) });

test("a GM-controlled turn ignores the GM's carried targets until they target fresh", () => {
  const gm = gmUser();
  const h = createHarness({ users: [gm] });
  const first = h.token("first");
  const second = h.token("second");
  const target = h.token("target");
  gm.targets.add(target);
  h.start(first);
  assert.equal(h.shown("first>target"), true, "nothing is carried on first load");

  h.turn(second);
  h.flush();
  assert.equal(h.leaving("first>target"), true);
  assert.equal(h.controller.lines.has("second>target"), false);
  h.emit("sightRefresh");
  h.flush();
  assert.equal(h.controller.lines.has("second>target"), false);

  gm.targets.delete(target);
  h.emit("targetToken", gm, target, false);
  h.target(gm, target);
  h.flush();
  assert.equal(h.shown("second>target"), true);

  // A new round also invalidates the GM's targets if the same NPC remains active.
  h.turn(second, { round: 2, turn: 1 });
  h.flush();
  assert.equal(h.leaving("second>target"), true);

  // Targeting between a turn update and its animation frame must not be discarded.
  h.turn(first, { turn: 0 });
  h.emit("targetToken", gm, target, true);
  h.flush();
  assert.equal(h.shown("first>target"), true);
  assert.equal(gm.targets.has(target), true, "display filtering must preserve Foundry targets");
  assert.equal(h.liveTimers().length, 0, "GM turns never hand off");
});

test("a player's standing targets show when their turn starts, and again next round", () => {
  const gm = gmUser();
  const seri = player("seri");
  const h = createHarness({ users: [gm, seri] });
  const orc = h.token("orc");
  const pc = h.token("pc", [seri]);
  const goblin = h.token("goblin");
  h.start(orc);

  // Seri lines up her attack while the orc is still acting.
  h.target(seri, goblin);
  h.flush();
  assert.equal(h.controller.lines.size, 0, "a player's targets never draw from the GM's creature");

  h.turn(pc);
  h.flush();
  assert.equal(h.shown("pc>goblin"), true, "standing target shows at turn start");

  h.turn(orc, { round: 2, turn: 0 });
  h.flush();
  assert.equal(h.leaving("pc>goblin"), true);

  h.turn(pc, { round: 2, turn: 1 });
  h.flush();
  assert.equal(h.shown("pc>goblin"), true, "the same target shows again next round without re-targeting");

  // A lone player combatant wrapping into the next round keeps its line up.
  h.turn(pc, { round: 3, turn: 1 });
  h.flush();
  assert.equal(h.shown("pc>goblin"), true);
  assert.equal(seri.targets.has(goblin), true, "Foundry targets are never written");
});

test("an NPC turn after a player turn still suppresses the GM's standing selection", () => {
  const gm = gmUser();
  const seri = player("seri");
  const h = createHarness({ users: [gm, seri] });
  const pc = h.token("pc", [seri]);
  const orc = h.token("orc");
  const goblin = h.token("goblin");
  h.start(pc);
  h.target(gm, goblin);
  h.flush();

  h.turn(orc);
  h.flush();
  assert.equal(h.controller.lines.has("orc>goblin"), false);
  h.target(gm, goblin);
  h.flush();
  assert.equal(h.shown("orc>goblin"), true);
});

/** Seri's character hands the turn to Seri's companion with the same target up. */
function handoffScenario({ calm }) {
  const gm = gmUser();
  const seri = player("seri");
  const h = createHarness({ users: [gm, seri], calm });
  const pc = h.token("pc", [seri]);
  const pet = h.token("pet", [seri]);
  const goblin = h.token("goblin");
  seri.targets.add(goblin);
  h.start(pc);
  assert.equal(h.shown("pc>goblin"), true);
  h.advance(2000);

  const handedOffAt = h.clock.now;
  h.turn(pet);
  h.flush();
  return { h, handedOffAt };
}

for (const calm of [false, true]) {
  test(`one player's consecutive turns retract, pause, then launch (${calm ? "calm" : "full"} motion)`, () => {
    const { h, handedOffAt } = handoffScenario({ calm });
    const motion = h.motion;
    const retract = calm ? motion.calmFadeOutMs : motion.retractDelayMs + motion.retractMs;
    const hold = retract + motion.handoffBeatMs;
    assert.ok(motion.handoffBeatMs > 0, "the beat is a real pause");

    assert.equal(h.leaving("pc>goblin"), true, "the old line starts retracting at once");
    assert.equal(h.controller.lines.has("pet>goblin"), false, "the new line waits, even for an unchanged target");
    assert.deepEqual(h.liveTimers().map(timer => timer.duration), [hold]);

    h.emit("sightRefresh");
    h.advance(hold - 1);
    assert.equal(h.controller.lines.has("pet>goblin"), false, "still waiting one millisecond before the launch");

    h.advance(1);
    assert.equal(h.shown("pet>goblin"), true);
    const [hidden] = h.events("pc>goblin").filter(entry => entry.event === "hide");
    const [launched] = h.events("pet>goblin");
    assert.equal(hidden.at, handedOffAt);
    assert.equal(launched.event, "show");
    assert.equal(launched.at - hidden.at, hold, "launch follows the full retract plus the beat");
  });
}

test("a turn passing to a different player launches straight away", () => {
  const gm = gmUser();
  const seri = player("seri");
  const tavi = player("tavi");
  const h = createHarness({ users: [gm, seri, tavi], calm: false });
  const seriPc = h.token("seri-pc", [seri]);
  const taviPc = h.token("tavi-pc", [tavi]);
  const goblin = h.token("goblin");
  seri.targets.add(goblin);
  tavi.targets.add(goblin);
  h.start(seriPc);

  h.turn(taviPc);
  h.flush();
  assert.equal(h.leaving("seri-pc>goblin"), true);
  assert.equal(h.shown("tavi-pc>goblin"), true);
  assert.equal(h.liveTimers().length, 0);
  assert.equal(h.events("tavi-pc>goblin")[0].at, h.events("seri-pc>goblin")[1].at, "overlapping, not sequential");
});

test("a shared token hands off when its controllers overlap the previous token's", () => {
  const gm = gmUser();
  const seri = player("seri");
  const tavi = player("tavi");
  const oren = player("oren");
  const h = createHarness({ users: [gm, seri, tavi, oren], calm: false });
  const seriPc = h.token("seri-pc", [seri]);
  const mount = h.token("mount", [seri, tavi]);
  const taviPc = h.token("tavi-pc", [tavi]);
  const orenPc = h.token("oren-pc", [oren]);
  const goblin = h.token("goblin");
  for (const user of [seri, tavi, oren]) user.targets.add(goblin);
  h.start(seriPc);
  const settle = () => h.advance(5000);

  // {seri} then {seri, tavi}: Seri may be acting on both turns.
  h.turn(mount);
  h.flush();
  assert.equal(h.controller.lines.has("mount>goblin"), false, "overlapping controllers hand off");
  settle();
  assert.equal(h.shown("mount>goblin"), true);

  // {seri, tavi} then {tavi}.
  h.turn(taviPc);
  h.flush();
  assert.equal(h.controller.lines.has("tavi-pc>goblin"), false, "overlap in either direction hands off");
  settle();
  assert.equal(h.shown("tavi-pc>goblin"), true);

  // {tavi} then {oren}: nobody in common.
  h.turn(orenPc);
  h.flush();
  assert.equal(h.shown("oren-pc>goblin"), true);
  assert.equal(h.liveTimers().length, 0);

  // A co-owner who is offline does not count as a controller.
  tavi.active = false;
  h.turn(mount);
  h.flush();
  settle();
  h.turn(taviPc);
  h.flush();
  assert.equal(h.liveTimers().length, 0, "the mount's only active controller was Seri, and tavi-pc is GM-run now");
});

test("a handoff with nothing on screen launches straight away", () => {
  const gm = gmUser();
  const seri = player("seri");
  const h = createHarness({ users: [gm, seri], calm: false });
  const pc = h.token("pc", [seri]);
  const pet = h.token("pet", [seri]);
  const goblin = h.token("goblin");
  h.start(pc);
  assert.equal(h.controller.lines.size, 0);

  h.target(seri, goblin);
  h.turn(pet);
  h.flush();
  assert.equal(h.liveTimers().length, 0);
  assert.equal(h.shown("pet>goblin"), true);
});

test("a turn change during a handoff cancels it", () => {
  const { h } = handoffScenario({ calm: false });
  const [pending] = h.liveTimers();
  assert.ok(pending);
  const orc = h.token("orc");
  h.turn(orc);
  h.flush();
  assert.equal(pending.cancelled, true);
  h.advance(5000);
  assert.equal(h.controller.lines.has("pet>goblin"), false, "a stale handoff never launches");
});

test("a canvas teardown cancels a pending handoff", () => {
  const { h } = handoffScenario({ calm: false });
  const [pending] = h.liveTimers();
  h.emit("canvasTearDown");
  assert.equal(pending.cancelled, true);
});

test("TargetLine retracts on the same clock the handoff waits for", () => {
  const calls = [];
  const graphics = class {
    destroyed = false;
    clear() {}
    destroy() {
      this.destroyed = true;
    }
  };
  const context = vm.createContext({
    console, Map, Set, JSON,
    animate: (_target, params) => calls.push(params),
    remove: () => {},
    PIXI: { Graphics: graphics, BLEND_MODES: { ADD: 1 } }
  });
  vm.runInContext([
    asScript(read("../scripts/constants.js")),
    asScript(read("../scripts/targeting/target-geometry.js")),
    asScript(read("../scripts/targeting/target-line.js")),
    "globalThis.TargetLine = TargetLine;",
    "globalThis.TARGET_LINE_MOTION = TARGET_LINE_MOTION;"
  ].join("\n"), context);
  const motion = context.TARGET_LINE_MOTION;
  const container = { addChild: child => child };
  const finish = () => Math.max(...calls.map(params => (params.delay ?? 0) + params.duration));
  const make = (calm, targetId = "b") => new context.TargetLine({
    sourceId: "a", targetId, halo: container, core: container, style: {}, calm
  });

  const line = make(false);
  calls.length = 0;
  line.show();
  assert.equal(finish(), Math.max(motion.launchMs, motion.launchMs - motion.ringInLeadMs + motion.ringInMs));
  line.state.reach = 1;
  calls.length = 0;
  line.hide();
  assert.equal(finish(), motion.retractDelayMs + motion.retractMs);

  const self = make(false, "a");
  self.show();
  self.state.reach = 1;
  calls.length = 0;
  self.hide();
  assert.ok(finish() <= motion.retractDelayMs + motion.retractMs);

  const calmLine = make(true);
  calls.length = 0;
  calmLine.show();
  assert.equal(finish(), motion.calmFadeInMs);
  calls.length = 0;
  calmLine.hide();
  assert.equal(finish(), motion.calmFadeOutMs);
});
