import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { test } from "node:test";

const read = path => readFileSync(new URL(path, import.meta.url), "utf8");
/** Module source as a plain script: single-line imports dropped (the sandbox supplies them), exports unwrapped. */
const asScript = code => code.replace(/^import .*;\r?\n/gm, "").replace(/^export /gm, "");

/**
 * A TargetLineController wired to fake Foundry globals, a fake TargetLine that logs show/hide/retarget, a
 * queued requestAnimationFrame and a fake anime.js timer clock.
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
    destroyed = false;
    nextSourceId = null;
    constructor(options) {
      Object.assign(this, options);
    }
    get key() {
      return `${this.nextSourceId ?? this.sourceId}>${this.targetId}`;
    }
    record(event) {
      log.push({ event, line: this, key: this.key, at: clock.now });
    }
    show() {
      if (this.nextSourceId != null) {
        this.sourceId = this.nextSourceId;
        this.nextSourceId = null;
        this.record("relaunch");
        return;
      }
      if (this.shown && !this.leaving) return;
      this.shown = true;
      this.leaving = false;
      this.record("show");
    }
    hide() {
      if (this.leaving) return;
      this.leaving = true;
      this.nextSourceId = null;
      this.record("hide");
    }
    retarget(sourceId) {
      if (this.leaving || !this.shown || this.nextSourceId === sourceId) return;
      this.nextSourceId = sourceId;
      this.record("retarget");
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
    untarget(user, token) {
      user.targets.delete(token);
      emit("targetToken", user, token, false);
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
      return Boolean(line?.shown && !line.leaving && line.nextSourceId == null);
    },
    leaving(key) {
      return controller.lines.get(key)?.leaving === true;
    },
    liveTimers() {
      return clock.timers.filter(timer => !timer.cancelled && !timer.fired);
    },
    /** Log entries for a line object, or for whatever line held a key when the entry was made. */
    events(lineOrKey) {
      return log.filter(entry => (typeof lineOrKey === "string" ? entry.key === lineOrKey : entry.line === lineOrKey));
    }
  };
  return harness;
}

const gmUser = (targets = []) => ({ id: "gm", active: true, isGM: true, targets: new Set(targets) });
const player = (id, targets = []) => ({ id, active: true, isGM: false, targets: new Set(targets) });
const holdFor = (motion, calm) => (calm
  ? motion.calmFadeOutMs + motion.calmHandoffBeatMs
  : Math.max(motion.retractMs, motion.reticleCollapseMs) + motion.handoffBeatMs);

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
  const line = h.controller.lines.get("pc>goblin");
  h.advance(2000);

  const handedOffAt = h.clock.now;
  h.turn(pet);
  h.flush();
  return { h, line, handedOffAt, seri, pc, pet, goblin };
}

for (const calm of [false, true]) {
  test(`one player's consecutive turns keep the reticle and move the origin (${calm ? "calm" : "full"} motion)`, () => {
    const { h, line, handedOffAt } = handoffScenario({ calm });
    const motion = h.motion;
    const hold = holdFor(motion, calm);
    assert.ok(motion.handoffBeatMs > 0 && motion.calmHandoffBeatMs > 0, "the beat is a real pause");

    assert.equal(h.controller.lines.get("pet>goblin"), line, "the same line carries the target across");
    assert.equal(h.controller.lines.has("pc>goblin"), false);
    assert.equal(line.leaving, false, "the reticle persists rather than collapsing");
    assert.equal(line.sourceId, "pc", "the body retracts into the old source first");
    assert.deepEqual(h.events(line).map(entry => entry.event), ["show", "retarget"]);
    assert.deepEqual(h.liveTimers().map(timer => timer.duration), [hold]);

    h.emit("sightRefresh");
    h.advance(hold - 1);
    assert.equal(line.sourceId, "pc", "still in the beat one millisecond before the launch");
    assert.equal(h.events(line).some(entry => entry.event === "relaunch"), false);

    h.advance(1);
    assert.equal(line.sourceId, "pet");
    assert.equal(h.shown("pet>goblin"), true);
    const retarget = h.events(line).find(entry => entry.event === "retarget");
    const relaunch = h.events(line).find(entry => entry.event === "relaunch");
    assert.equal(retarget.at, handedOffAt);
    assert.equal(relaunch.at - retarget.at, hold, "launch follows the full retract plus the beat");
  });
}

test("a handoff onto a different target collapses the old reticle and launches after the beat", () => {
  const gm = gmUser();
  const seri = player("seri");
  const h = createHarness({ users: [gm, seri], calm: false });
  const pc = h.token("pc", [seri]);
  const pet = h.token("pet", [seri]);
  const goblin = h.token("goblin");
  const orc = h.token("orc");
  seri.targets.add(goblin);
  h.start(pc);
  const old = h.controller.lines.get("pc>goblin");
  h.advance(2000);

  // Seri switches targets as the turn passes, before the frame that redraws.
  h.untarget(seri, goblin);
  h.target(seri, orc);
  const handedOffAt = h.clock.now;
  h.turn(pet);
  h.flush();
  assert.equal(old.leaving, true, "the old reticle collapses");
  assert.equal(h.events(old).some(entry => entry.event === "retarget"), false);
  assert.equal(h.controller.lines.has("pet>orc"), false, "the new line waits for the retract and beat");

  const hold = holdFor(h.motion, false);
  h.advance(hold);
  assert.equal(h.shown("pet>orc"), true);
  assert.equal(h.events("pet>orc")[0].at - handedOffAt, hold);
});

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
  const old = h.controller.lines.get("seri-pc>goblin");

  h.turn(taviPc);
  h.flush();
  assert.equal(old.leaving, true, "a different player's turn does not keep the reticle");
  assert.equal(h.shown("tavi-pc>goblin"), true);
  assert.notEqual(h.controller.lines.get("tavi-pc>goblin"), old);
  assert.equal(h.liveTimers().length, 0);
  assert.equal(h.events("tavi-pc>goblin")[0].at, h.events(old)[1].at, "overlapping, not sequential");
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
  const orc = h.token("orc");
  seri.targets.add(goblin);
  tavi.targets.add(goblin);
  tavi.targets.add(orc);
  oren.targets.add(goblin);
  h.start(seriPc);
  const settle = () => h.advance(5000);
  const carried = h.controller.lines.get("seri-pc>goblin");

  // {seri} then {seri, tavi}: Seri may be acting on both turns. The mount's targets are both owners'.
  h.turn(mount);
  h.flush();
  assert.equal(h.liveTimers().length, 1, "overlapping controllers hand off");
  assert.equal(h.controller.lines.get("mount>goblin"), carried, "the shared target keeps its reticle");
  assert.equal(h.controller.lines.has("mount>orc"), false, "a target new to this turn waits for the beat");
  settle();
  assert.equal(h.shown("mount>goblin"), true);
  assert.equal(h.shown("mount>orc"), true);

  // {seri, tavi} then {tavi}.
  h.turn(taviPc);
  h.flush();
  assert.equal(h.liveTimers().length, 1, "overlap in either direction hands off");
  settle();
  assert.equal(h.shown("tavi-pc>goblin"), true);
  assert.equal(h.shown("tavi-pc>orc"), true);

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

test("a turn change during a handoff cancels it and collapses the kept reticle", () => {
  const { h, line } = handoffScenario({ calm: false });
  const [pending] = h.liveTimers();
  assert.ok(pending);
  const orc = h.token("orc");
  h.turn(orc);
  h.flush();
  assert.equal(pending.cancelled, true);
  assert.equal(line.leaving, true);
  h.advance(5000);
  assert.equal(h.events(line).some(entry => entry.event === "relaunch"), false, "a stale handoff never launches");
});

test("a second handoff during the beat carries the reticle on to the next token", () => {
  const { h, line, seri } = handoffScenario({ calm: false });
  const familiar = h.token("familiar", [seri]);
  h.advance(100);
  h.turn(familiar);
  h.flush();
  assert.equal(h.controller.lines.get("familiar>goblin"), line);
  assert.equal(h.liveTimers().length, 1);
  h.advance(5000);
  assert.equal(line.sourceId, "familiar");
  assert.equal(h.shown("familiar>goblin"), true);
});

test("a canvas teardown cancels a pending handoff", () => {
  const { h } = handoffScenario({ calm: false });
  const [pending] = h.liveTimers();
  h.emit("canvasTearDown");
  assert.equal(pending.cancelled, true);
});

/** The real TargetLine against a recording anime.js and a recording PIXI.Graphics. */
function loadTargetLine() {
  const animations = [];
  class Graphics {
    ops = [];
    blendMode = 0;
    destroyed = false;
    clear() {
      this.ops.length = 0;
      return this;
    }
    lineStyle(options, color, alpha) {
      this.ops.push(typeof options === "object" ? { op: "line", ...options } : { op: "line", width: options, color, alpha });
      return this;
    }
    beginFill(color, alpha) {
      this.ops.push({ op: "fill", color, alpha });
      return this;
    }
    endFill() {
      return this;
    }
    moveTo(x, y) {
      this.ops.push({ op: "moveTo", x, y });
      return this;
    }
    lineTo(x, y) {
      this.ops.push({ op: "lineTo", x, y });
      return this;
    }
    arc(x, y, radius, start, end) {
      this.ops.push({ op: "arc", x, y, radius, start, end });
      return this;
    }
    drawCircle(x, y, radius) {
      this.ops.push({ op: "circle", x, y, radius });
      return this;
    }
    closePath() {
      return this;
    }
    destroy() {
      this.destroyed = true;
    }
  }
  const context = vm.createContext({
    console, Map, Set, JSON,
    animate: (target, params) => {
      const animation = {
        target,
        params,
        paused: false,
        cancelled: false,
        pause() {
          this.paused = true;
          return this;
        },
        resume() {
          this.paused = false;
          return this;
        },
        cancel() {
          this.cancelled = true;
          return this;
        }
      };
      animations.push(animation);
      return animation;
    },
    remove: () => {},
    PIXI: {
      Graphics,
      BLEND_MODES: { NORMAL: 0, ADD: 1 },
      LINE_CAP: { ROUND: "round" },
      LINE_JOIN: { ROUND: "round" }
    }
  });
  vm.runInContext([
    asScript(read("../scripts/constants.js")),
    asScript(read("../scripts/targeting/target-geometry.js")),
    asScript(read("../scripts/targeting/target-line.js")),
    "globalThis.TargetLine = TargetLine;",
    "globalThis.MOTION = TARGET_LINE_MOTION;",
    "globalThis.INK = INK;",
    "globalThis.HANDOFF_ALPHA = RETICLE_HANDOFF_ALPHA;"
  ].join("\n"), context);
  const container = { addChild: child => child };
  return {
    animations,
    motion: context.MOTION,
    INK: context.INK,
    HANDOFF_ALPHA: context.HANDOFF_ALPHA,
    make: ({ calm = false, sourceId = "a", targetId = "b", color = 0x4db8ff } = {}) => new context.TargetLine({
      sourceId, targetId, halo: container, core: container, glint: container, style: { color, intensity: 1 }, calm
    }),
    since: mark => animations.slice(mark),
    finish: list => Math.max(...list.map(animation => (animation.params.delay ?? 0) + animation.params.duration)),
    last: (list, property) => list.filter(animation => property in animation.params).at(-1)?.params
  };
}

test("TargetLine launches and collapses on the shared clock", () => {
  const t = loadTargetLine();
  const motion = t.motion;
  const line = t.make();
  let mark = t.animations.length;
  line.show();
  assert.equal(t.finish(t.since(mark)), motion.launchMs, "the reticle pop lands with the line");

  Object.assign(line.state, { reach: 1, ringAlpha: 1, ringScale: 1 });
  mark = t.animations.length;
  line.hide();
  const hide = t.since(mark);
  assert.equal(t.finish(hide), Math.max(motion.retractMs, motion.reticleCollapseMs));
  assert.equal(t.last(hide, "ringAlpha").ringAlpha, 0, "a removed target's reticle collapses");
  assert.ok(hide.some(animation => animation.params.onComplete), "hide removes the line when done");

  const calm = t.make({ calm: true });
  mark = t.animations.length;
  calm.show();
  assert.equal(t.finish(t.since(mark)), motion.calmFadeInMs);
  mark = t.animations.length;
  calm.hide();
  assert.equal(t.finish(t.since(mark)), motion.calmFadeOutMs);
});

test("TargetLine retarget keeps the reticle at 45% with loops frozen, then relaunches from the new source", () => {
  const t = loadTargetLine();
  const motion = t.motion;
  const line = t.make();
  const loops = t.animations.filter(animation => animation.params.loop);
  assert.equal(loops.length, 3, "sweep, spin and pulse");
  line.show();
  Object.assign(line.state, { reach: 1, ringAlpha: 1, ringScale: 1 });

  let mark = t.animations.length;
  line.retarget("c");
  const retract = t.since(mark);
  assert.equal(line.sourceId, "a", "the body retracts into the old source");
  assert.equal(line.leaving, false);
  assert.equal(t.HANDOFF_ALPHA, 0.45);
  assert.equal(t.last(retract, "ringAlpha").ringAlpha, t.HANDOFF_ALPHA);
  assert.equal(t.last(retract, "reach").reach, 0);
  assert.equal(t.finish(retract), motion.retractMs, "retract, including the origin sink, fits the controller's wait");
  assert.ok(retract.some(animation => "sink" in animation.params), "a ring sinks into the old source");
  assert.ok(retract.every(animation => !animation.params.onComplete), "nothing removes a retargeted line");
  assert.ok(loops.every(loop => loop.paused), "loops freeze through the handoff");

  line.state.reach = 0;
  mark = t.animations.length;
  line.show();
  const relaunch = t.since(mark);
  assert.equal(line.sourceId, "c");
  assert.ok(loops.every(loop => !loop.paused), "loops resume on relaunch");
  assert.equal(t.last(relaunch, "reach").duration, motion.launchMs);
  assert.equal(t.last(relaunch, "ringAlpha").ringAlpha, 1);
  assert.equal(t.finish(relaunch), motion.launchMs);
  assert.ok(relaunch.some(animation => "rise" in animation.params && animation.params.duration === motion.originRiseMs));

  // The target changed during the beat instead: the kept reticle collapses.
  const again = t.make();
  again.show();
  again.retarget("c");
  mark = t.animations.length;
  again.hide();
  assert.equal(t.last(t.since(mark), "ringAlpha").ringAlpha, 0);
  assert.equal(again.nextSourceId, null);
});

test("TargetLine retarget in calm motion fades the body and dims the reticle", () => {
  const t = loadTargetLine();
  const motion = t.motion;
  const line = t.make({ calm: true });
  assert.equal(t.animations.filter(animation => animation.params.loop).length, 0, "no loops in calm");
  line.show();
  let mark = t.animations.length;
  line.retarget("c");
  const fade = t.since(mark);
  assert.equal(t.last(fade, "body").body, 0);
  assert.equal(t.last(fade, "ringAlpha").ringAlpha, t.HANDOFF_ALPHA);
  assert.equal(t.finish(fade), motion.calmFadeOutMs);
  assert.equal(fade.some(animation => "sink" in animation.params), false, "no origin cue in calm");

  mark = t.animations.length;
  line.show();
  const back = t.since(mark);
  assert.equal(line.sourceId, "c");
  assert.equal(t.last(back, "body").body, 1);
  assert.equal(t.finish(back), motion.calmFadeInMs);
});

test("the Etched Bow draws device-pixel hairlines in the line's own colours", () => {
  const t = loadTargetLine();
  const color = 0x4db8ff;
  const line = t.make({ color });
  line.show();
  Object.assign(line.state, { reach: 1, body: 1, ringAlpha: 1, ringScale: 1, pulse: 0.5, sweep: 0.5, spin: 1 });
  const token = (x, y, size = 100) => ({ document: {}, center: { x, y }, w: size, h: size });
  const render = (scale, resolution) => line.render({
    source: token(50, 50), target: token(550, 50), scale, gridSize: 100, resolution
  });
  const strokes = graphics => graphics.ops.filter(op => op.op === "line" && op.width > 0);
  const halo = line.haloGraphics;
  const core = line.coreGraphics;
  const glint = line.glintGraphics;

  render(2, 1.5);
  const hairline = 1 / (2 * 1.5);
  assert.ok(Math.abs(Math.min(...strokes(core).map(op => op.width)) - hairline) < 1e-9, "hairline is one device pixel");
  assert.ok(Math.min(...strokes(halo).map(op => op.width)) > 4 * hairline, "no hairlines inside the blurred halo");
  const allowed = new Set([color, line.bright, t.INK, 0xffffff]);
  for (const graphics of [halo, core, glint]) {
    for (const op of graphics.ops) {
      if ((op.op === "line" && op.width > 0) || op.op === "fill") {
        assert.ok(allowed.has(op.color), `unexpected colour #${op.color.toString(16)}`);
      }
      for (const value of Object.values(op)) {
        if (typeof value === "number") assert.ok(Number.isFinite(value), `non-finite ${op.op}`);
      }
    }
  }
  assert.equal(glint.blendMode, 1, "the sweep adds light");
  assert.notEqual(core.blendMode, 1, "the etched rim must not be additive, or INK draws nothing");
  assert.ok(strokes(glint).length > 0, "the light sweep runs while the line holds");
  assert.ok(core.ops.some(op => op.op === "fill" && op.color === color), "the head wedge is drawn");

  const path = line.path;
  render(0.5, 1);
  assert.equal(line.path, path, "the path buffer is reused every frame");
  assert.ok(Math.abs(Math.min(...strokes(core).map(op => op.width)) - 2) < 1e-9, "hairline follows zoom and resolution");

  line.state.reach = 0.5;
  render(1, 1);
  assert.equal(strokes(glint).length, 0, "no sweep on a body that is moving");

  const calm = t.make({ calm: true, color });
  calm.show();
  Object.assign(calm.state, { reach: 1, body: 1, ringAlpha: 1, ringScale: 1, sweep: 0.5 });
  calm.render({ source: token(50, 50), target: token(550, 50), scale: 1, gridSize: 100, resolution: 1 });
  assert.equal(strokes(calm.glintGraphics).length, 0, "calm motion has no sweep");
});
