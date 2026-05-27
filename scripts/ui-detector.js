import { CLASSES, CORE_UI_SELECTORS, MODULE_ID } from "./constants.js";
import { getUiRules, setSetting } from "./settings.js";

export class UiDetector {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.entries = new Map();
    this.observer = null;
    this.warnedSelectors = new Set();
    this.appliedZIndex = new Map();
  }

  registerHooks() {
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => active ? this.start() : this.stop());
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (key === "uiRules") this.applyRules();
    });
    Hooks.on("renderApplicationV2", (app, html) => this.trackApplication(app, html));
    Hooks.on("renderApplication", (app, html) => this.trackApplication(app, html));
  }

  start() {
    this.scan();
    this.observer ??= new MutationObserver(mutations => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node instanceof HTMLElement) this.trackElement(node);
        }
      }
      this.applyRules();
      Hooks.callAll(`${MODULE_ID}.uiDetectedChanged`);
    });
    this.observer.observe(document.body, { childList: true, subtree: true });
  }

  stop() {
    this.observer?.disconnect();
    this.observer = null;
    document.querySelectorAll(`.${CLASSES.blockedUi}, .${CLASSES.allowedUi}`).forEach(element => {
      element.classList.remove(CLASSES.blockedUi, CLASSES.allowedUi);
    });
    this.#restoreZIndex();
  }

  scan() {
    document.querySelectorAll(".app, .window-app, .application, [style*='position: fixed'], [style*='position:absolute']").forEach(element => this.trackElement(element));
    this.applyRules();
  }

  trackApplication(app, html) {
    const element = getElement(html) ?? getElement(app?.element);
    if (!element) return;
    this.trackElement(element, app);
    this.applyRules();
  }

  trackElement(element, app = null) {
    if (!element?.isConnected || element.closest("#gluniverse-stream-overlay")) return;
    if (!isFloatingCandidate(element) && !app) return;
    const metadata = createMetadata(element, app);
    this.entries.set(metadata.ruleId, metadata);
  }

  getEntries() {
    this.scan();
    const rules = getUiRules();
    return Array.from(this.entries.values()).map(entry => ({
      ...entry,
      state: rules.elementRules[entry.ruleId] ?? "default",
      zIndex: rules.elementZIndex[entry.ruleId] ?? "",
      lastSeenLabel: new Date(entry.lastSeen).toLocaleTimeString()
    })).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  async setElementRule(ruleId, action) {
    const rules = getUiRules();
    if (action === "default") delete rules.elementRules[ruleId];
    else rules.elementRules[ruleId] = action;
    await setSetting("uiRules", rules);
  }

  async setElementZIndex(ruleId, zIndex) {
    const rules = getUiRules();
    const number = Number(zIndex);
    if (zIndex === "" || zIndex === null || zIndex === undefined || !Number.isFinite(number)) delete rules.elementZIndex[ruleId];
    else rules.elementZIndex[ruleId] = number;
    await setSetting("uiRules", rules);
  }

  async addSelectorRule(selector, action, zIndex) {
    document.querySelectorAll(selector);
    const rules = getUiRules();
    const rule = { id: foundry.utils.randomID(), selector, action };
    const number = Number(zIndex);
    if (zIndex !== "" && zIndex !== null && zIndex !== undefined && Number.isFinite(number)) rule.zIndex = number;
    rules.selectorRules.push(rule);
    await setSetting("uiRules", rules);
  }

  async removeSelectorRule(ruleId) {
    const rules = getUiRules();
    rules.selectorRules = rules.selectorRules.filter(rule => rule.id !== ruleId);
    await setSetting("uiRules", rules);
  }

  applyRules() {
    if (!this.streamMode.active) return;
    const rules = getUiRules();
    this.#restoreZIndex();
    document.querySelectorAll(`.${CLASSES.blockedUi}, .${CLASSES.allowedUi}`).forEach(element => {
      element.classList.remove(CLASSES.blockedUi, CLASSES.allowedUi);
    });
    for (const entry of this.entries.values()) {
      const element = document.querySelector(entry.selector);
      if (!element) continue;
      const action = rules.elementRules[entry.ruleId];
      if (action === "block") element.classList.add(CLASSES.blockedUi);
      if (action === "allow") {
        element.classList.add(CLASSES.allowedUi);
        this.#applyZIndex(element, rules.elementZIndex[entry.ruleId]);
      }
    }

    for (const rule of rules.selectorRules) {
      try {
        document.querySelectorAll(rule.selector).forEach(element => {
          if (element.closest("#gluniverse-stream-overlay")) return;
          if (rule.action === "block") element.classList.add(CLASSES.blockedUi);
          if (rule.action === "allow") {
            element.classList.remove(CLASSES.blockedUi);
            element.classList.add(CLASSES.allowedUi);
            this.#applyZIndex(element, rule.zIndex);
          }
        });
      } catch (error) {
        if (!this.warnedSelectors.has(rule.selector)) {
          console.warn(`${MODULE_ID} | Ignoring invalid selector rule: ${rule.selector}`, error);
          this.warnedSelectors.add(rule.selector);
        }
      }
    }
  }

  #applyZIndex(element, zIndex) {
    const value = Number(zIndex);
    if (!Number.isFinite(value)) return;
    if (!this.appliedZIndex.has(element)) this.appliedZIndex.set(element, element.style.zIndex);
    element.style.zIndex = String(value);
  }

  #restoreZIndex() {
    for (const [element, original] of this.appliedZIndex) {
      if (original) element.style.zIndex = original;
      else element.style.removeProperty("z-index");
    }
    this.appliedZIndex.clear();
  }
}

function createMetadata(element, app) {
  const selector = suggestedSelector(element);
  const appClass = app?.constructor?.name ?? "";
  const source = classifySource(element, appClass);
  return {
    ruleId: appClass ? `app:${appClass}` : selector,
    elementId: element.id ?? "",
    classes: Array.from(element.classList).join(" "),
    selector,
    title: app?.title ?? element.getAttribute("aria-label") ?? element.querySelector(".window-title")?.textContent?.trim() ?? "",
    appClass,
    packageId: app?.constructor?.metadata?.packageName ?? "",
    source,
    visible: element.offsetParent !== null,
    lastSeen: Date.now()
  };
}

function classifySource(element, appClass) {
  if (CORE_UI_SELECTORS.some(selector => safeMatches(element, selector) || element.closest(selector))) return "core";
  if (appClass.startsWith("Scene") || appClass.startsWith("Token") || appClass.startsWith("Chat")) return "core";
  return "unknown";
}

function isFloatingCandidate(element) {
  const style = window.getComputedStyle(element);
  const zIndex = Number.parseInt(style.zIndex, 10);
  return ["fixed", "absolute"].includes(style.position)
    || Number.isFinite(zIndex) && zIndex >= 100
    || element.matches(".app, .window-app, .application");
}

function suggestedSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`;
  const classes = Array.from(element.classList).filter(Boolean).slice(0, 3).map(cls => `.${CSS.escape(cls)}`).join("");
  return classes ? `${element.tagName.toLowerCase()}${classes}` : element.tagName.toLowerCase();
}

function safeMatches(element, selector) {
  try {
    return element.matches(selector);
  } catch (_error) {
    return false;
  }
}

function getElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  return null;
}
