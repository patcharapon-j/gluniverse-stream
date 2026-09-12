import { CLASSES, MODULE_ID } from "./constants.js";
import { animate, prefersCalmMotion, remove } from "./motion/engine.js";
import { getDialogSettings } from "./settings.js";

const BACKDROP_ALPHA = 0.25;

export class DialogOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.entries = new Map();
    this.backdropHandler = null;
    this.backdropRoot = null;
  }

  registerHooks() {
    Hooks.on("renderApplicationV2", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderApplication", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderDialogV2", (app, html) => this.trackApplication(app, html, true));
    Hooks.on("renderDialog", (app, html) => this.trackApplication(app, html, true));
    Hooks.on("closeApplicationV2", app => this.clearApplication(app));
    Hooks.on("closeApplication", app => this.clearApplication(app));
    Hooks.on("closeDialogV2", app => this.clearApplication(app));
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
    animateIn(element);

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

  /** Play the exit animation, then close the application without Foundry's own close animation. */
  async closeApplication(key, app, element) {
    this.#discardEntry(key);
    await animateOut(element);
    try {
      if (typeof app?.close === "function") await app.close({ force: true, animate: false });
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
    fadeBackdrop(root, BACKDROP_ALPHA);
  }

  #disableBackdropClose() {
    this.#detachBackdrop();
  }

  #detachBackdrop() {
    if (this.backdropRoot && this.backdropHandler) {
      this.backdropRoot.classList.remove(CLASSES.dialogRootInteractive);
      this.backdropRoot.removeEventListener("click", this.backdropHandler);
      fadeBackdrop(this.backdropRoot, 0);
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

/**
 * Presentations rise into place with a small overshoot. The dialog's own `transform` is pinned by the
 * overlay stylesheet, so the scale and lift go through the independent `scale`/`translate` properties
 * via CSS variables. Inline values are cleared afterwards so Foundry's own window styling is untouched.
 */
function animateIn(element) {
  remove(element);
  const clear = () => clearMotionStyles(element);
  if (prefersCalmMotion()) {
    animate(element, { opacity: [0, 1], duration: 220, ease: "linear", onComplete: clear });
    return;
  }
  animate(element, { opacity: [0, 1], duration: 260, ease: "outQuad" });
  animate(element, {
    "--stream-dialog-scale": [0.94, 1],
    "--stream-dialog-y": ["14px", "0px"],
    duration: 460,
    ease: "outBack(1.4)",
    onComplete: clear
  });
}

function animateOut(element) {
  if (!element?.isConnected) return Promise.resolve();
  remove(element);
  return new Promise(resolve => {
    if (prefersCalmMotion()) {
      animate(element, { opacity: [1, 0], duration: 180, ease: "linear", onComplete: resolve });
      return;
    }
    animate(element, { opacity: [1, 0], duration: 240, ease: "inQuad" });
    animate(element, {
      "--stream-dialog-scale": [1, 0.96],
      "--stream-dialog-y": ["0px", "8px"],
      duration: 260,
      ease: "inCubic",
      onComplete: resolve
    });
  });
}

function fadeBackdrop(root, alpha) {
  const current = Number.parseFloat(root.style.getPropertyValue("--stream-dialog-backdrop")) || 0;
  remove(root);
  if (prefersCalmMotion()) {
    root.style.setProperty("--stream-dialog-backdrop", String(alpha));
    return;
  }
  animate(root, { "--stream-dialog-backdrop": [current, alpha], duration: alpha > current ? 260 : 220, ease: "outQuad" });
}

function clearMotionStyles(element) {
  element.style.removeProperty("opacity");
  element.style.removeProperty("--stream-dialog-scale");
  element.style.removeProperty("--stream-dialog-y");
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
