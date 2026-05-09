import { CLASSES, MODULE_ID } from "./constants.js";
import { getDialogSettings } from "./settings.js";

export class DialogOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.entries = new Map();
    this.backdropHandler = null;
    this.backdropRoot = null;
  }

  registerHooks() {
    Hooks.on("renderApplicationV2", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderApplicationV1", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderDialog", (app, html) => this.trackApplication(app, html, true));
    Hooks.on("closeApplication", app => this.clearApplication(app));
    Hooks.on("closeApplicationV2", app => this.clearApplication(app));
    Hooks.on("closeApplicationV1", app => this.clearApplication(app));
    Hooks.on("closeDialog", app => this.clearApplication(app));
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => {
      if (!active) this.#reset();
    });
  }

  trackApplication(app, html, force = false) {
    if (!this.streamMode.active) return;
    const element = getElement(html) ?? getElement(app?.element);
    if (!element || element.closest(`#${MODULE_ID}-director`) || element.closest("#gluniverse-stream-overlay")) return;
    if (!force && !isStreamPresentation(app, element)) return;
    const key = app ?? element;
    if (this.entries.has(key)) return;

    element.classList.add(CLASSES.centeredDialog);
    const kind = classifyPresentation(app, element);
    if (kind === "image") element.classList.add(CLASSES.imagePresentation);
    else if (kind === "journal") element.classList.add(CLASSES.journalPresentation);
    this.streamMode.getDialogRoot().append(element);

    const lifetime = getLifetimeMs();
    if (lifetime > 0) {
      const timeout = window.setTimeout(() => this.closeApplication(key, app, element), lifetime);
      this.entries.set(key, { timeout, app, element, manual: false });
    } else {
      element.classList.add(CLASSES.manualCloseDialog);
      this.entries.set(key, { timeout: null, app, element, manual: true });
      this.#enableBackdropClose();
    }
  }

  async closeApplication(key, app, element) {
    this.#discardEntry(key);
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
    this.#discardEntry(app);
  }

  #discardEntry(key) {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.timeout) window.clearTimeout(entry.timeout);
    this.entries.delete(key);
    if (![...this.entries.values()].some(other => other.manual)) this.#disableBackdropClose();
  }

  #enableBackdropClose() {
    const root = this.streamMode.getDialogRoot();
    if (!root) return;
    if (this.backdropRoot === root && this.backdropHandler) return;
    this.#detachBackdrop();
    const handler = event => {
      if (event.target !== root) return;
      for (const [key, entry] of [...this.entries.entries()]) {
        if (entry.manual) this.closeApplication(key, entry.app, entry.element);
      }
    };
    root.classList.add(CLASSES.dialogRootInteractive);
    root.addEventListener("click", handler);
    this.backdropHandler = handler;
    this.backdropRoot = root;
  }

  #disableBackdropClose() {
    this.#detachBackdrop();
  }

  #detachBackdrop() {
    if (this.backdropRoot && this.backdropHandler) {
      this.backdropRoot.classList.remove(CLASSES.dialogRootInteractive);
      this.backdropRoot.removeEventListener("click", this.backdropHandler);
    }
    this.backdropHandler = null;
    this.backdropRoot = null;
  }

  #reset() {
    for (const entry of this.entries.values()) {
      if (entry.timeout) window.clearTimeout(entry.timeout);
    }
    this.entries.clear();
    this.#detachBackdrop();
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

function classifyPresentation(app, element) {
  const className = app?.constructor?.name ?? "";
  const documentName = app?.document?.documentName ?? app?.object?.documentName ?? "";
  if (className.includes("ImagePopout")
    || element.matches(".image-popout")
    || element.classList.contains("image-popout")
    || element.querySelector(".window-content > img, .image-popout img")) return "image";
  if (className.includes("Journal")
    || documentName.includes("Journal")
    || element.matches(".journal-sheet, .journal-entry, .journal-entry-page")
    || element.querySelector(".journal-entry-content, .journal-page-content")) return "journal";
  return "dialog";
}

function getLifetimeMs() {
  const lifetime = Number(getDialogSettings().lifetimeMs);
  return Number.isFinite(lifetime) ? lifetime : 10000;
}

function getElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  return null;
}
