import { CLASSES, MODULE_ID } from "./constants.js";
import { getDialogSettings } from "./settings.js";

export class DialogOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.timers = new Map();
  }

  registerHooks() {
    Hooks.on("renderApplicationV2", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderApplicationV1", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderDialog", (app, html) => this.trackApplication(app, html, true));
    Hooks.on("closeApplication", app => this.clearApplication(app));
    Hooks.on("closeApplicationV2", app => this.clearApplication(app));
    Hooks.on("closeApplicationV1", app => this.clearApplication(app));
    Hooks.on("closeDialog", app => this.clearApplication(app));
  }

  trackApplication(app, html, force = false) {
    if (!this.streamMode.active) return;
    const element = getElement(html) ?? getElement(app?.element);
    if (!element || element.closest(`#${MODULE_ID}-director`) || element.closest("#gluniverse-stream-overlay")) return;
    if (!force && !isStreamPresentation(app, element)) return;
    const key = app ?? element;
    if (this.timers.has(key)) return;

    element.classList.add(CLASSES.centeredDialog);
    this.streamMode.getDialogRoot().append(element);

    const timeout = window.setTimeout(() => this.closeApplication(key, app, element), getLifetimeMs());
    this.timers.set(key, timeout);
  }

  async closeApplication(key, app, element) {
    this.timers.delete(key);
    try {
      if (typeof app?.close === "function") await app.close({ force: true });
    } catch (error) {
      try {
        if (typeof app?.close === "function") await app.close();
      } catch (fallbackError) {
        console.warn(`${MODULE_ID} | Failed to auto-close stream presentation`, fallbackError);
      }
    } finally {
      if (element?.isConnected && element.closest(`#${MODULE_ID}-stream-overlay, #gluniverse-stream-overlay`)) element.remove();
    }
  }

  clearApplication(app) {
    const timeout = this.timers.get(app);
    if (timeout) window.clearTimeout(timeout);
    this.timers.delete(app);
  }
}

function isStreamPresentation(app, element) {
  const className = app?.constructor?.name ?? "";
  const documentName = app?.document?.documentName ?? app?.object?.documentName ?? "";
  return className.includes("Dialog")
    || className.includes("ImagePopout")
    || className.includes("Journal")
    || documentName.includes("Journal")
    || element.matches(".dialog, [role='dialog']")
    || element.classList.contains("dialog")
    || element.matches(".image-popout, .journal-sheet, .journal-entry, .journal-entry-page")
    || element.querySelector(".dialog-buttons, [data-dialog-button], .journal-entry-content, .journal-page-content, img[data-action='showImage']");
}

function getLifetimeMs() {
  const lifetime = Number(getDialogSettings().lifetimeMs);
  return Number.isFinite(lifetime) ? Math.max(0, lifetime) : 10000;
}

function getElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  return null;
}
