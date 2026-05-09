import {
  CAMERA_MODES,
  CHAT_POSITIONS,
  MODULE_ID,
  SCENE_VIEW_MODES,
  STREAM_COMMANDS
} from "./constants.js";
import { getCameraSettings, getChatSettings, getDialogSettings, getSetting, getUiRules, isDirectorUser, setSetting } from "./settings.js";
import { getStreamClientStatus, requestStreamClientStatus, sendStreamCommand } from "./socket.js";

let services = {};
let instance = null;

export function configureDirectorApp(nextServices) {
  services = nextServices;
}

export function openDirectorApp() {
  if (!isDirectorUser()) return ui.notifications?.warn(game.i18n.localize("GLUNIVERSE_STREAM.notifications.notDirector"));
  requestStreamClientStatus();
  instance ??= new StreamDirectorApp();
  instance.render({ force: true });
}

export function renderDirectorApp() {
  if (instance?.rendered) instance.renderPreservingScroll();
}

export function addStreamSceneControl(controls) {
  if (!isDirectorUser()) return;
  const group = {
    name: "gluniverse-stream",
    title: game.i18n.localize("GLUNIVERSE_STREAM.controls.group"),
    icon: "fas fa-video",
    visible: true,
    tools: [
      {
        name: "director",
        title: game.i18n.localize("GLUNIVERSE_STREAM.controls.director"),
        icon: "fas fa-broadcast-tower",
        button: true,
        visible: true,
        onClick: () => openDirectorApp(),
        onChange: () => openDirectorApp()
      }
    ]
  };

  if (Array.isArray(controls)) controls.push(group);
  else if (controls && typeof controls === "object") {
    controls["gluniverse-stream"] = {
      ...group,
      tools: {
        director: group.tools[0]
      }
    };
  }
}

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

class StreamDirectorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  restoreScroll = null;

  static DEFAULT_OPTIONS = {
    id: `${MODULE_ID}-director`,
    classes: ["gluniverse-stream-director"],
    tag: "form",
    window: {
      title: "GLUniverse Stream Director",
      icon: "fas fa-video"
    },
    position: { width: 720, height: 760 },
    actions: {}
  };

  static PARTS = {
    main: { template: `modules/${MODULE_ID}/templates/director.hbs` }
  };

  async _prepareContext(options) {
    const camera = getCameraSettings();
    const chat = getChatSettings();
    const dialog = getDialogSettings();
    const uiRules = getUiRules();
    const status = getStreamClientStatus();
    const activeMode = getActiveCameraMode(camera);
    const streamUserId = getSetting("streamUserId");
    const autoStartIds = getSetting("autoStartStreamUserIds") ?? [];
    const trusted = new Set(getSetting("trustedDirectorUserIds") ?? []);
    const streamConnected = Boolean(streamUserId && game.users?.get(streamUserId)?.active);
    const streamActive = Boolean(status?.active);
    return {
      ...(await super._prepareContext(options)),
      status: {
        stream: status ? (status.active ? "Active" : "Inactive") : "No report yet",
        restore: status ? (status.restoreVisible ? "Temporarily visible" : "Hidden") : "No report yet",
        connected: streamConnected,
        stopDisabled: streamActive ? "" : "disabled",
        restoreDisabled: streamActive ? "" : "disabled",
        reframeDisabled: streamActive ? "" : "disabled",
        autoStart: streamUserId && autoStartIds.includes(streamUserId) ? "Enabled" : "Disabled",
        autoStartEnabled: Boolean(streamUserId && autoStartIds.includes(streamUserId)),
        autoStartCanEnable: Boolean(streamUserId && !autoStartIds.includes(streamUserId)),
        scene: canvas?.scene?.name ?? game.i18n.localize("GLUNIVERSE_STREAM.common.none"),
        mode: cameraModeLabel(activeMode),
        combat: getCurrentSceneCombat() ? "Yes" : "No"
      },
      users: game.users?.map(user => ({
        id: user.id,
        name: user.name,
        active: user.active,
        isGM: user.isGM,
        isStream: user.id === streamUserId,
        trusted: trusted.has(user.id),
        selected: user.id === streamUserId ? "selected" : "",
        checked: trusted.has(user.id) ? "checked" : ""
      })) ?? [],
      camera,
      chat,
      dialog,
      tokenRows: services.tokenTracking?.getTokenRows() ?? [],
      combatRows: getCombatRows(),
      detectedUi: services.uiDetector?.getEntries() ?? [],
      selectorRules: uiRules.selectorRules,
      outOfCombatModeOptions: optionsFor({
        [CAMERA_MODES.manual]: "Manual/free camera",
        [CAMERA_MODES.scene]: "Scene/full background",
        [CAMERA_MODES.trackedToken]: "Tracked token(s)",
        [CAMERA_MODES.party]: "Party only (visible PCs)"
      }, camera.outOfCombatMode),
      combatModeOptions: optionsFor({
        [CAMERA_MODES.manual]: "Manual/free camera",
        [CAMERA_MODES.scene]: "Scene/full background",
        [CAMERA_MODES.trackedToken]: "Tracked token(s)",
        [CAMERA_MODES.party]: "Party only (visible PCs)",
        [CAMERA_MODES.combatants]: "Visible combatants"
      }, camera.combatMode),
      sceneViewOptions: optionsFor({
        [SCENE_VIEW_MODES.fitBackground]: "Fit background",
        [SCENE_VIEW_MODES.fillBackground]: "Fill background"
      }, camera.sceneViewMode),
      chatPositionOptions: optionsFor(Object.fromEntries(CHAT_POSITIONS.map(position => [position, labelize(position)])), chat.position)
    };
  }

  async _onFirstRender(context, options) {
    await super._onFirstRender(context, options);
    this.element.addEventListener("change", event => this.#onChange(event));
    this.element.addEventListener("click", event => this.#onClick(event));
    this.element.addEventListener("submit", event => event.preventDefault());
  }

  async _onRender(context, options) {
    await super._onRender(context, options);
    if (this.restoreScroll) {
      const scroll = this.restoreScroll;
      this.restoreScroll = null;
      queueMicrotask(() => this.#restoreScroll(scroll));
      requestAnimationFrame(() => this.#restoreScroll(scroll));
      window.setTimeout(() => this.#restoreScroll(scroll), 0);
    }
  }

  renderPreservingScroll() {
    this.#captureScroll();
    return this.render({ force: true });
  }

  #captureScroll() {
    const content = this.#windowContentElement();
    const next = {
      body: this.element?.querySelector(".gluniverse-stream-director-body")?.scrollTop ?? 0,
      content: content?.scrollTop ?? 0
    };
    this.restoreScroll = this.restoreScroll
      ? { body: Math.max(this.restoreScroll.body, next.body), content: Math.max(this.restoreScroll.content, next.content) }
      : next;
  }

  #restoreScroll(scroll) {
    const body = this.element?.querySelector(".gluniverse-stream-director-body");
    const content = this.#windowContentElement();
    if (body) body.scrollTop = scroll.body;
    if (content) content.scrollTop = scroll.content;
  }

  #windowContentElement() {
    return this.element?.closest(".window-content") ?? this.element?.querySelector(".window-content");
  }

  async #onChange(event) {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
    const name = target.name;
    if (!name) return;

    if (name === "streamUserId") return this.#setAndRender("streamUserId", target.value);
    if (name === "trustedDirectorUserIds") {
      const ids = Array.from(this.element.querySelectorAll("input[name='trustedDirectorUserIds']:checked")).map(input => input.value);
      return this.#setAndRender("trustedDirectorUserIds", ids);
    }
    if (name.startsWith("camera.")) return this.#updateObject("cameraSettings", name.slice(7), fieldValue(target));
    if (name.startsWith("chat.")) return this.#updateObject("chatSettings", name.slice(5), fieldValue(target));
    if (name.startsWith("dialog.")) return this.#updateObject("dialogSettings", name.slice(7), fieldValue(target));
  }

  async #onClick(event) {
    const button = event.target.closest("[data-action]");
    if (!button) return;
    event.preventDefault();
    const action = button.dataset.action;
    switch (action) {
      case "start":
        return sendStreamCommand(STREAM_COMMANDS.start);
      case "stop":
        return sendStreamCommand(STREAM_COMMANDS.stop);
      case "toggle-restore":
        return sendStreamCommand(STREAM_COMMANDS.toggleRestore);
      case "enable-auto-start":
        return this.#setAutoStart(true);
      case "revoke-auto-start":
        return this.#setAutoStart(false);
      case "reframe":
        requestStreamClientStatus();
        return services.camera?.requestReframe({ force: true });
      case "toggle-token":
        this.#captureScroll();
        return services.tokenTracking?.toggleTokenById(button.dataset.tokenId);
      case "ui-allow":
      case "ui-block":
      case "ui-default":
        this.#captureScroll();
        return services.uiDetector?.setElementRule(button.dataset.ruleId, action.replace("ui-", ""));
      case "selector-add":
        return this.#addSelectorRule();
      case "selector-remove":
        this.#captureScroll();
        return services.uiDetector?.removeSelectorRule(button.dataset.ruleId);
    }
  }

  async #setAndRender(key, value) {
    this.#captureScroll();
    await setSetting(key, value);
  }

  async #updateObject(key, field, value) {
    this.#captureScroll();
    const current = key === "cameraSettings" ? getCameraSettings() : key === "chatSettings" ? getChatSettings() : getDialogSettings();
    await setSetting(key, { ...current, [field]: value });
  }

  async #addSelectorRule() {
    const selector = this.element.querySelector("input[name='selectorRule.selector']")?.value?.trim();
    const action = this.element.querySelector("select[name='selectorRule.action']")?.value;
    if (!selector) return;
    try {
      this.#captureScroll();
      await services.uiDetector?.addSelectorRule(selector, action);
    } catch (error) {
      ui.notifications?.warn(game.i18n.localize("GLUNIVERSE_STREAM.notifications.invalidSelector"));
    }
  }

  async #setAutoStart(enabled) {
    const streamUserId = getSetting("streamUserId");
    if (!streamUserId) return;
    this.#captureScroll();
    const ids = new Set(getSetting("autoStartStreamUserIds") ?? []);
    if (enabled) ids.add(streamUserId);
    else ids.delete(streamUserId);
    await setSetting("autoStartStreamUserIds", Array.from(ids));
  }
}

function getCombatRows() {
  return getCombatants(game.combat).map(combatant => ({
    id: combatant.id,
    tokenId: combatant.tokenId,
    name: combatant.name,
    defeated: combatant.defeated,
    onScene: (combatant.scene?.id ?? combatant.sceneId) === canvas?.scene?.id
  }));
}

function getCurrentSceneCombat() {
  const combat = game.combat;
  if (!combat) return null;
  const sceneId = combat.scene?.id ?? combat.sceneId;
  if (!sceneId) return combat;
  return sceneId === canvas?.scene?.id ? combat : null;
}

function getCombatants(combat) {
  const combatants = combat?.combatants;
  if (!combatants) return [];
  if (Array.isArray(combatants)) return combatants;
  if (typeof combatants.contents !== "undefined") return combatants.contents;
  return Array.from(combatants);
}

function getActiveCameraMode(camera) {
  return getCurrentSceneCombat() ? camera.combatMode : camera.outOfCombatMode;
}

function cameraModeLabel(mode) {
  const labels = {
    [CAMERA_MODES.manual]: "Manual/free camera",
    [CAMERA_MODES.scene]: "Scene/full background",
    [CAMERA_MODES.trackedToken]: "Tracked token(s)",
    [CAMERA_MODES.party]: "Party only",
    [CAMERA_MODES.combatants]: "Visible combatants"
  };
  return labels[mode] ?? mode;
}

function optionsFor(labels, selected) {
  return Object.entries(labels).map(([value, label]) => ({ value, label, selected: value === selected ? "selected" : "" }));
}

function labelize(value) {
  return value.split("-").map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

function fieldValue(target) {
  if (target.type === "checkbox") return target.checked;
  if (target.type === "number" || target.dataset.type === "number") return Number(target.value);
  return target.value;
}
