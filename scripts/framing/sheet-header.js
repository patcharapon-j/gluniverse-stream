import { MODULE_ID } from "../constants.js";
import { isDirectorUser } from "../settings.js";
import { openPortraitFramingApp } from "./portrait-framing-app.js";

/** Both the ApplicationV2 control's `action` and the ApplicationV1 button's class. */
const ACTION = `${MODULE_ID}-frame-art`;

/**
 * Header controls fire `getHeaderControls<ClassName>` for every class a sheet inherits from, and system
 * sheets sit at different depths, so the whole chain an actor sheet can go through is listened to. The
 * duplicate a chain produces is dropped by the `action` check in `addControl`.
 */
const V2_HOOKS = [
  "getHeaderControlsApplicationV2",
  "getHeaderControlsDocumentSheetV2",
  "getHeaderControlsActorSheetV2"
];

/**
 * Puts "Frame For Stream" in the header of every actor sheet a Director owns, so an NPC that is not in
 * the party and not in combat can still be framed for its roll cards, straight from its sheet.
 */
export function registerFramingSheetHeader() {
  Hooks.on("getActorSheetHeaderButtons", (sheet, buttons) => {
    const actor = sheet?.actor ?? sheet?.document;
    if (!Array.isArray(buttons) || !canFrame(actor) || buttons.some(button => button?.class === ACTION)) return;
    buttons.unshift({ class: ACTION, icon: "fas fa-crop-simple", label: label(), onclick: () => openFor(actor) });
  });
  for (const hook of V2_HOOKS) Hooks.on(hook, (app, controls) => addControl(app, controls));
  // An ApplicationV2 header control only names an action, which the sheet itself would have to handle,
  // so the click is caught here instead: in capture, so a sheet cannot swallow it first, and without
  // stopping it, so the controls menu still closes itself afterwards.
  document.addEventListener("click", onClick, true);
}

function addControl(app, controls) {
  const actor = app?.document;
  if (!Array.isArray(controls) || !canFrame(actor)) return;
  if (controls.some(control => control?.action === ACTION)) return;
  controls.push({ action: ACTION, icon: "fas fa-crop-simple", label: label(), visible: true });
}

function onClick(event) {
  const control = event.target?.closest?.(`[data-action="${ACTION}"]`);
  if (!control) return;
  event.preventDefault();
  const actor = actorOf(control);
  if (actor) openFor(actor);
}

/** The actor of the sheet the clicked control belongs to. */
function actorOf(control) {
  const root = control.closest(".application");
  const app = root?.id ? foundry.applications.instances?.get(root.id) : null;
  return canFrame(app?.document) ? app.document : null;
}

function openFor(actor) {
  if (!canFrame(actor)) return;
  openPortraitFramingApp({ actor });
}

/** Directors frame art; ownership still decides who may write the actor's flag. */
function canFrame(actor) {
  return actor?.documentName === "Actor" && !!actor.isOwner && isDirectorUser();
}

function label() {
  return game.i18n.localize("GLUNIVERSE_STREAM.sheetHeader.frameArt");
}
