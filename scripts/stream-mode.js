import { CLASSES, MODULE_ID } from "./constants.js";
import { emitClientStatus, requestAutoStartSet } from "./socket.js";
import { isAutoStartStreamUser, isConfiguredStreamUser } from "./settings.js";

export class StreamMode {
  active = false;
  restoreVisible = false;
  overlayRoot = null;
  promptOpen = false;

  get isStreamUser() {
    return isConfiguredStreamUser();
  }

  async promptIfNeeded() {
    if (!this.isStreamUser || this.active) return;
    if (isAutoStartStreamUser()) return this.activate({ notify: false, source: "auto" });
    await this.requestStart({ notify: false, source: "ready" });
  }

  async requestStart({ notify = true } = {}) {
    if (!this.isStreamUser || this.active || this.promptOpen) return;
    if (isAutoStartStreamUser()) return this.activate({ notify, source: "auto" });
    this.promptOpen = true;
    const choice = await this.#showStartPrompt().finally(() => {
      this.promptOpen = false;
    });
    if (choice === "always") {
      await requestAutoStartSet(true);
      this.activate({ notify, source: "always" });
    } else if (choice === "start") this.activate({ notify, source: "prompt" });
    else this.reportStatus();
  }

  activate({ notify = true } = {}) {
    if (!this.isStreamUser) return;
    if (this.active) {
      this.reportStatus();
      return false;
    }
    this.active = true;
    this.restoreVisible = false;
    document.body.classList.add(CLASSES.active);
    document.body.classList.remove(CLASSES.restore);
    this.#ensureOverlayRoot();
    emitClientStatus({ active: true, restoreVisible: false, sceneId: canvas?.scene?.id ?? null });
    Hooks.callAll(`${MODULE_ID}.streamModeChanged`, true);
    if (notify) ui.notifications?.info(game.i18n.localize("GLUNIVERSE_STREAM.notifications.streamStarted"));
    return true;
  }

  deactivate({ notify = true } = {}) {
    if (!this.active) {
      this.reportStatus();
      return false;
    }
    this.active = false;
    this.restoreVisible = false;
    document.body.classList.remove(CLASSES.active, CLASSES.restore);
    this.overlayRoot?.remove();
    this.overlayRoot = null;
    emitClientStatus({ active: false, restoreVisible: false, sceneId: canvas?.scene?.id ?? null });
    Hooks.callAll(`${MODULE_ID}.streamModeChanged`, false);
    if (notify) ui.notifications?.info(game.i18n.localize("GLUNIVERSE_STREAM.notifications.streamStopped"));
    return true;
  }

  reportStatus() {
    if (!this.isStreamUser) return;
    emitClientStatus({ active: this.active, restoreVisible: this.restoreVisible, sceneId: canvas?.scene?.id ?? null });
  }

  toggleRestore() {
    if (!this.active) {
      this.reportStatus();
      return false;
    }
    this.restoreVisible = !this.restoreVisible;
    document.body.classList.toggle(CLASSES.restore, this.restoreVisible);
    emitClientStatus({ active: true, restoreVisible: this.restoreVisible, sceneId: canvas?.scene?.id ?? null });
    Hooks.callAll(`${MODULE_ID}.restoreToggled`, this.restoreVisible);
    return this.restoreVisible;
  }

  getChatRoot() {
    return this.#ensureOverlayRoot().querySelector(`.${CLASSES.chatRoot}`);
  }

  getDialogRoot() {
    return this.#ensureOverlayRoot().querySelector(`.${CLASSES.dialogRoot}`);
  }

  #ensureOverlayRoot() {
    if (this.overlayRoot?.isConnected) return this.overlayRoot;
    const root = document.createElement("div");
    root.id = "gluniverse-stream-overlay";
    root.className = CLASSES.overlayRoot;
    root.innerHTML = `<section class="${CLASSES.chatRoot}" aria-live="polite"></section><section class="${CLASSES.dialogRoot}" aria-live="polite"></section>`;
    document.body.append(root);
    this.overlayRoot = root;
    return root;
  }

  async #showStartPrompt() {
    const content = await foundry.applications.handlebars.renderTemplate(`modules/${MODULE_ID}/templates/start-prompt.hbs`, {});
    const choice = await foundry.applications.api.DialogV2.wait({
      window: { title: game.i18n.localize("GLUNIVERSE_STREAM.startPrompt.title") },
      content,
      buttons: [
        { action: "start", label: game.i18n.localize("GLUNIVERSE_STREAM.startPrompt.start"), default: true, callback: () => "start" },
        { action: "always", label: game.i18n.localize("GLUNIVERSE_STREAM.startPrompt.always"), callback: () => "always" },
        { action: "cancel", label: game.i18n.localize("GLUNIVERSE_STREAM.startPrompt.cancel"), callback: () => "cancel" }
      ],
      rejectClose: false
    });
    return choice ?? "cancel";
  }
}
