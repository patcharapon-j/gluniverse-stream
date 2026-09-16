import { MODULE_ID } from "../constants.js";
import { RollCard } from "../cards/roll-card.js";
import { artFor } from "../pf2e/read-message.js";
import { getDefaultRollArt, isDirectorUser, setSetting } from "../settings.js";
import { ART_ASPECT, defaultCrop, isFocus, placement, toFocus } from "./focus-math.js";
import { portraitFramer } from "./portrait-framer.js";

const FLAG = "portraitFocus";
const VIEW_W = 410;
const MIN_W = 0.08;
/** The entry for the picture GM rolls with no art of their own fall back to. */
const DEFAULT_ART_KEY = "default-roll-art";

const { ApplicationV2 } = foundry.applications.api;

let instance = null;

/**
 * Opens the framing editor.
 *
 * @param {object} [options]
 * @param {Actor} [options.actor]      An actor to add to the list and select, e.g. from its sheet header.
 * @param {boolean} [options.defaultArt]  Select the default GM roll art instead.
 */
export function openPortraitFramingApp({ actor = null, defaultArt = false } = {}) {
  instance ??= new PortraitFramingApp();
  if (actor?.uuid) instance.pin(actor);
  else if (defaultArt) instance.pendingSelect = { key: DEFAULT_ART_KEY };
  instance.render({ force: true });
}

/**
 * Lets a GM set where each character's roll card art is framed. The focus is saved on the actor per
 * image, and wins over face detection on the stream. Drag to pan, scroll or use the slider to zoom.
 * The world's default GM roll art is framed here too, and is saved in the module's settings instead.
 */
class PortraitFramingApp extends ApplicationV2 {
  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-portrait-framing`,
    classes: ["gluniverse-stream-framing"],
    window: { title: "Roll Card Portrait Framing", icon: "fas fa-crop-simple" },
    position: { width: 760, height: 560 }
  };

  selectedKey = null;
  focus = null;
  image = null;
  /** Actor uuids added from a sheet header, kept for as long as the editor is open. */
  pinned = new Set();
  /** An entry to select once the next render has collected it. */
  pendingSelect = null;

  /** Adds an actor to the list and selects it, however the actor got here. */
  pin(actor) {
    this.pinned.add(actor.uuid);
    this.pendingSelect = { actorUuid: actor.uuid };
  }

  async _renderHTML() {
    const entries = collectEntries(this.pinned);
    this.entries = entries;
    const wanted = this.pendingSelect;
    this.pendingSelect = null;
    const requested = wanted
      ? entries.find(e => (wanted.key ? e.key === wanted.key : e.actorUuid === wanted.actorUuid))
      : null;
    if (requested) this.selectedKey = requested.key;
    // Art the card would not show either — a default icon, or no picture at all — has nothing to frame.
    else if (wanted?.actorUuid) ui.notifications?.warn("That actor has no art to frame. Give it a portrait or a token picture first.");
    if (!entries.some(e => e.key === this.selectedKey)) this.selectedKey = entries[0]?.key ?? null;

    const root = document.createElement("div");
    root.className = "glus-framing";
    const list = document.createElement("ul");
    list.className = "glus-framing-list";
    for (const entry of entries) {
      const item = document.createElement("li");
      item.dataset.key = entry.key;
      item.classList.toggle("active", entry.key === this.selectedKey);
      const thumb = document.createElement("img");
      thumb.src = entry.src;
      thumb.alt = "";
      const label = document.createElement("span");
      label.textContent = entry.name;
      const state = document.createElement("small");
      state.textContent = entry.override ? "Set by GM" : "Automatic";
      label.append(state);
      item.append(thumb, label);
      list.append(item);
    }
    if (!entries.length) {
      const empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = "No characters with art. Assign player characters, start a combat, or open an actor sheet and use Frame For Stream.";
      list.append(empty);
    }

    const editor = document.createElement("section");
    editor.className = "glus-framing-editor";
    editor.innerHTML = `
      <p class="hint">Drag to move the picture, scroll or use the slider to zoom. The stream uses this framing instead of face detection.</p>
      <div class="glus-framing-view" style="width:${VIEW_W}px;height:${Math.round(VIEW_W / ART_ASPECT)}px"><img alt=""></div>
      <label class="glus-framing-zoom">Zoom <input type="range" min="0" max="1" step="0.001"></label>
      <div class="glus-framing-preview"></div>
      <div class="glus-framing-buttons">
        <button type="button" data-do="auto"><i class="fas fa-wand-magic-sparkles"></i> Auto-detect</button>
        <button type="button" data-do="clear"><i class="fas fa-rotate-left"></i> Use automatic</button>
        <button type="button" data-do="save"><i class="fas fa-floppy-disk"></i> Save framing</button>
      </div>`;
    root.append(list, editor);
    return root;
  }

  _replaceHTML(result, content) {
    content.replaceChildren(result);
    this.bind(result);
    this.select(this.selectedKey);
  }

  bind(root) {
    root.querySelector(".glus-framing-list").addEventListener("click", event => {
      const item = event.target.closest("li[data-key]");
      if (!item) return;
      root.querySelectorAll(".glus-framing-list li").forEach(li => li.classList.toggle("active", li === item));
      this.select(item.dataset.key);
    });

    const view = root.querySelector(".glus-framing-view");
    let drag = null;
    view.addEventListener("pointerdown", event => {
      if (!this.focus) return;
      drag = { x: event.clientX, y: event.clientY, focus: { ...this.focus } };
      view.setPointerCapture(event.pointerId);
    });
    view.addEventListener("pointermove", event => {
      if (!drag) return;
      const perPx = drag.focus.w / VIEW_W;
      this.setFocus({ ...drag.focus, x: drag.focus.x - (event.clientX - drag.x) * perPx, y: drag.focus.y - (event.clientY - drag.y) * perPx });
    });
    view.addEventListener("pointerup", () => (drag = null));
    view.addEventListener("pointercancel", () => (drag = null));
    view.addEventListener("wheel", event => {
      if (!this.focus) return;
      event.preventDefault();
      this.zoomTo(this.focus.w * (event.deltaY > 0 ? 1.08 : 1 / 1.08));
    }, { passive: false });

    root.querySelector(".glus-framing-zoom input").addEventListener("input", event => {
      // Slider 0 shows the widest framing the picture allows, 1 the closest.
      const max = this.maxWidth();
      this.zoomTo(max - Number(event.target.value) * (max - MIN_W));
    });

    root.querySelector(".glus-framing-buttons").addEventListener("click", event => {
      const action = event.target.closest("button[data-do]")?.dataset.do;
      if (action === "auto") this.autoDetect();
      if (action === "clear") this.saveOverride(null);
      if (action === "save") this.saveOverride(this.focus);
    });
  }

  async select(key) {
    this.selectedKey = key;
    const entry = this.current();
    const view = this.element?.querySelector(".glus-framing-view img");
    if (!entry || !view) return;
    this.image = await loadNaturalSize(entry.src);
    if (this.current() !== entry) return;
    view.src = entry.src;
    const start = entry.override ?? portraitFramer.peek(entry.src) ?? toFocus(defaultCrop(this.image.width, this.image.height), this.image.width);
    this.setFocus(start);
  }

  current() {
    return this.entries?.find(e => e.key === this.selectedKey) ?? null;
  }

  /** Widest crop, in image widths, that still fits the picture's height. */
  maxWidth() {
    const ratio = this.image ? this.image.height / this.image.width : 1;
    return Math.min(1, ratio * ART_ASPECT);
  }

  zoomTo(width) {
    const f = this.focus;
    if (!f) return;
    const w = Math.max(MIN_W, Math.min(this.maxWidth(), width));
    const cx = f.x + f.w / 2;
    const cy = f.y + f.w / ART_ASPECT / 2;
    this.setFocus({ x: cx - w / 2, y: cy - w / ART_ASPECT / 2, w });
  }

  setFocus(focus) {
    if (!this.image) return;
    const ratio = this.image.height / this.image.width;
    const w = Math.max(MIN_W, Math.min(this.maxWidth(), focus.w));
    const x = Math.max(0, Math.min(1 - w, focus.x));
    const y = Math.max(0, Math.min(ratio - w / ART_ASPECT, focus.y));
    this.focus = { x: round(x), y: round(y), w: round(w) };

    const root = this.element;
    const img = root.querySelector(".glus-framing-view img");
    const { scale, left, top } = placement(this.focus);
    img.style.width = `${scale * VIEW_W}px`;
    img.style.left = `${left * VIEW_W}px`;
    img.style.top = `${top * VIEW_W}px`;
    const max = this.maxWidth();
    root.querySelector(".glus-framing-zoom input").value = max > MIN_W ? (max - w) / (max - MIN_W) : 0;
    this.renderPreview();
  }

  renderPreview() {
    const entry = this.current();
    const host = this.element?.querySelector(".glus-framing-preview");
    if (!entry || !host) return;
    const card = new RollCard({
      id: "preview",
      kind: "check",
      visibility: "public",
      actor: { name: entry.name, isNpc: entry.isNpc, img: entry.src, imgKind: entry.imgKind ?? (entry.isNpc ? "token" : "portrait"), focus: this.focus },
      player: entry.isNpc ? null : { name: entry.player ?? "Player" },
      target: null,
      action: { label: "Framing preview", sub: null, map: 0 },
      roll: { natural: 14, total: 24, dc: 20, dcVisible: true, degree: 2 },
      spell: null,
      damage: null,
      fx: null
    });
    const total = card.element.querySelector(".glus-rc-total");
    if (total) total.textContent = "24";
    host.replaceChildren(card.element);
  }

  async autoDetect() {
    const entry = this.current();
    if (!entry) return;
    ui.notifications?.info("Looking for a face… the first run loads the detector.");
    portraitFramer.cache.delete(entry.src);
    const focus = await portraitFramer.request(entry.src);
    if (this.current() !== entry) return;
    if (focus) this.setFocus(focus);
    else ui.notifications?.warn("No face found in this picture. Frame it by hand.");
  }

  async saveOverride(focus) {
    const entry = this.current();
    if (!entry) return;
    const saved = isFocus(focus) ? { x: focus.x, y: focus.y, w: focus.w } : null;
    if (entry.isDefaultArt) {
      if (!isDirectorUser()) return ui.notifications?.warn(game.i18n.localize("GLUNIVERSE_STREAM.notifications.notDirector"));
      await setSetting("defaultRollArt", { ...getDefaultRollArt(), focus: saved });
    } else {
      const actor = fromUuidSync(entry.actorUuid);
      if (!actor) return;
      if (!actor.isOwner) return ui.notifications?.warn("You need to own this actor to change its framing.");
      const others = (actor.getFlag(MODULE_ID, FLAG) ?? []).filter(o => o?.src !== entry.src);
      const next = saved ? [...others, { src: entry.src, ...saved }] : others;
      if (next.length) await actor.setFlag(MODULE_ID, FLAG, next);
      else await actor.unsetFlag(MODULE_ID, FLAG);
    }
    ui.notifications?.info(saved ? `Saved framing for ${entry.name}.` : `${entry.name} is framed automatically again.`);
    this.render();
  }
}

/**
 * Everything the stream can show art for: the world's default GM roll art, then player characters, the
 * party, current combatants, selected tokens and any actor opened from its sheet, each with the art its
 * card shows.
 *
 * @param {Set<string>} [pinned]  Actor uuids added from a sheet header.
 */
function collectEntries(pinned = new Set()) {
  const entries = new Map();
  const add = (actor, token, isNpc, player) => {
    const base = token?.baseActor ?? actor;
    const src = artFor(actor?.img, token?.texture?.src, isNpc);
    if (!base || !src) return;
    const key = `${base.uuid}|${src}`;
    if (entries.has(key)) return;
    const override = (base.getFlag(MODULE_ID, FLAG) ?? []).find(o => o?.src === src && isFocus(o)) ?? null;
    entries.set(key, { key, actorUuid: base.uuid, name: token?.name ?? actor.name, src, isNpc, player, override });
  };
  const defaultArt = getDefaultRollArt();
  if (defaultArt.src) {
    entries.set(DEFAULT_ART_KEY, {
      key: DEFAULT_ART_KEY,
      isDefaultArt: true,
      actorUuid: null,
      name: "Default GM roll",
      src: defaultArt.src,
      isNpc: true,
      // The reader frames this picture like a portrait, so the preview must too.
      imgKind: "portrait",
      player: null,
      override: isFocus(defaultArt.focus) ? defaultArt.focus : null
    });
  }
  for (const user of game.users ?? []) if (user.character && !user.isGM) add(user.character, user.character.prototypeToken, false, user.name);
  for (const member of game.actors?.party?.members ?? []) add(member, member.prototypeToken, false);
  for (const combatant of game.combat?.combatants ?? []) {
    const actor = combatant.actor;
    if (actor) add(actor, combatant.token, !actor.hasPlayerOwner);
  }
  for (const token of canvas?.tokens?.controlled ?? []) {
    if (token.actor) add(token.actor, token.document, !token.actor.hasPlayerOwner);
  }
  for (const uuid of pinned) {
    const actor = fromUuidSync(uuid);
    if (actor) add(actor, actor.token ?? actor.prototypeToken, !actor.hasPlayerOwner);
  }
  return [...entries.values()];
}

function loadNaturalSize(src) {
  return new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({ width: 1, height: 1 });
    image.src = src;
  });
}

function round(n) {
  return Math.round(n * 10000) / 10000;
}
