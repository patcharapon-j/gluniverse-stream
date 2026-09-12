import {
  CAMERA_MODES,
  DEFAULT_CAMERA_SETTINGS,
  DEFAULT_CHAT_SETTINGS,
  DEFAULT_DIALOG_SETTINGS,
  DEFAULT_UI_RULES,
  MODULE_ID
} from "./constants.js";
import { requestSettingSet } from "./socket.js";

const SETTINGS = {
  streamUserId: { type: String, default: "", config: true },
  autoStartStreamUserIds: { type: Array, default: [], config: false },
  trustedDirectorUserIds: { type: Array, default: [], config: false },
  cameraSettings: { type: Object, default: DEFAULT_CAMERA_SETTINGS, config: false },
  chatSettings: { type: Object, default: DEFAULT_CHAT_SETTINGS, config: false },
  dialogSettings: { type: Object, default: DEFAULT_DIALOG_SETTINGS, config: false },
  uiRules: { type: Object, default: DEFAULT_UI_RULES, config: false }
};

export function registerSettings() {
  for (const [key, data] of Object.entries(SETTINGS)) {
    game.settings.register(MODULE_ID, key, {
      name: game.i18n.localize(`GLUNIVERSE_STREAM.settings.${key}.name`),
      hint: game.i18n.localize(`GLUNIVERSE_STREAM.settings.${key}.hint`),
      scope: "world",
      config: data.config,
      type: data.type,
      default: duplicateDefault(data.default),
      onChange: value => Hooks.callAll(`${MODULE_ID}.settingsChanged`, key, sanitizeSetting(key, value))
    });
  }
}

export function getSetting(key) {
  return sanitizeSetting(key, game.settings.get(MODULE_ID, key));
}

export async function setSetting(key, value) {
  const sanitized = sanitizeSetting(key, value);
  if (game.user?.isGM) return game.settings.set(MODULE_ID, key, sanitized);
  requestSettingSet(key, sanitized);
  return sanitized;
}

export async function updateObjectSetting(key, patch) {
  const next = foundry.utils.mergeObject(getSetting(key) ?? {}, patch, { inplace: false, insertKeys: true, overwrite: true });
  return setSetting(key, next);
}

export function getCameraSettings() {
  return sanitizeCameraSettings(getSetting("cameraSettings"));
}

export function getChatSettings() {
  return { ...DEFAULT_CHAT_SETTINGS, ...(getSetting("chatSettings") ?? {}) };
}

export function getDialogSettings() {
  return { ...DEFAULT_DIALOG_SETTINGS, ...(getSetting("dialogSettings") ?? {}) };
}

export function getUiRules() {
  const rules = getSetting("uiRules") ?? {};
  return {
    elementRules: rules.elementRules ?? {},
    elementZIndex: rules.elementZIndex ?? {},
    selectorRules: Array.isArray(rules.selectorRules) ? rules.selectorRules : []
  };
}

export function isConfiguredStreamUser(user = game.user) {
  return Boolean(user?.id && getSetting("streamUserId") === user.id);
}

export function isAutoStartStreamUser(user = game.user) {
  return Boolean(user?.id && (getSetting("autoStartStreamUserIds") ?? []).includes(user.id));
}

export function isDirectorUser(user = game.user) {
  if (!user) return false;
  if (user.isGM) return true;
  return (getSetting("trustedDirectorUserIds") ?? []).includes(user.id);
}

export function sanitizeSetting(key, value) {
  switch (key) {
    case "trustedDirectorUserIds":
    case "autoStartStreamUserIds":
      return Array.isArray(value) ? value.filter(Boolean) : [];
    case "cameraSettings":
      return sanitizeCameraSettings(value);
    case "chatSettings":
      return sanitizeObject(value, DEFAULT_CHAT_SETTINGS);
    case "dialogSettings":
      return sanitizeObject(value, DEFAULT_DIALOG_SETTINGS);
    case "uiRules":
      return sanitizeUiRules(value);
    case "streamUserId":
      return typeof value === "string" ? value : "";
    default:
      return value ?? SETTINGS[key]?.default;
  }
}

/**
 * Camera settings are rebuilt from the current defaults' keys, so settings the camera no longer reads
 * drop out the next time a Director saves. Older worlds are migrated on the way:
 * - `nonCombatMode`, `mode` and `sceneModeView` became the current mode keys.
 * - Uniform `paddingPercent` / `paddingGridSpaces` became per-side padding.
 * - `spotlightPullback` + `spotlightPullbackFactor` became `travelZoomOut` (1 means off). The old
 *   "Follow ms" and "Zoom-out ms" durations have no speed equivalent, so pan speed starts at default.
 */
function sanitizeCameraSettings(value) {
  const source = (value && typeof value === "object") ? value : {};
  const migrated = { ...source };
  if (!migrated.outOfCombatMode && source.nonCombatMode) migrated.outOfCombatMode = migrateCameraMode(source.nonCombatMode);
  if (!migrated.combatMode && source.mode) migrated.combatMode = source.mode === "combat" ? CAMERA_MODES.combatants : migrateCameraMode(source.mode);
  if (!migrated.sceneViewMode && source.sceneModeView) migrated.sceneViewMode = source.sceneModeView;
  migrateSidePadding(migrated, source, "paddingPercent", 10, ["paddingPercentTop", "paddingPercentRight", "paddingPercentBottom", "paddingPercentLeft"]);
  migrateSidePadding(migrated, source, "paddingGridSpaces", 0, ["paddingGridSpacesTop", "paddingGridSpacesRight", "paddingGridSpacesBottom", "paddingGridSpacesLeft"]);
  if (!Number.isFinite(Number(source.travelZoomOut)) && ("spotlightPullback" in source || "spotlightPullbackFactor" in source)) {
    migrated.travelZoomOut = source.spotlightPullback === false ? 1 : numberOrDefault(source.spotlightPullbackFactor, DEFAULT_CAMERA_SETTINGS.travelZoomOut);
  }
  migrated.travelZoomOut = Math.max(1, numberOrDefault(migrated.travelZoomOut, DEFAULT_CAMERA_SETTINGS.travelZoomOut));
  const panSpeed = Number(migrated.panSpeed);
  migrated.panSpeed = Number.isFinite(panSpeed) && panSpeed > 0 ? panSpeed : DEFAULT_CAMERA_SETTINGS.panSpeed;
  return pickDefaults(migrated, DEFAULT_CAMERA_SETTINGS);
}

function migrateSidePadding(migrated, source, uniformKey, uniformDefault, sideKeys) {
  const uniform = numberOrDefault(source[uniformKey], uniformDefault);
  for (const key of sideKeys) migrated[key] = numberOrDefault(source[key], uniform);
}

function pickDefaults(value, defaults) {
  return Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, key in value ? value[key] : fallback]));
}

function numberOrDefault(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function migrateCameraMode(mode) {
  switch (mode) {
    case "players":
      return CAMERA_MODES.party;
    case "manualTokens":
      return CAMERA_MODES.trackedToken;
    case "combat":
      return CAMERA_MODES.combatants;
    default:
      return Object.values(CAMERA_MODES).includes(mode) ? mode : CAMERA_MODES.scene;
  }
}

function sanitizeObject(value, defaults) {
  return { ...defaults, ...((value && typeof value === "object") ? value : {}) };
}

function sanitizeUiRules(value) {
  const rules = (value && typeof value === "object") ? value : {};
  const elementRules = {};
  for (const [id, action] of Object.entries(rules.elementRules ?? {})) {
    if (["allow", "block", "default"].includes(action)) elementRules[id] = action;
  }
  const elementZIndex = {};
  for (const [id, zIndex] of Object.entries(rules.elementZIndex ?? {})) {
    const number = Number(zIndex);
    if (Number.isFinite(number)) elementZIndex[id] = number;
  }
  const selectorRules = Array.isArray(rules.selectorRules)
    ? rules.selectorRules
      .filter(rule => rule?.selector && ["allow", "block"].includes(rule.action))
      .map(rule => {
        const zIndex = Number(rule.zIndex);
        const { zIndex: _ignored, ...rest } = rule;
        return Number.isFinite(zIndex) ? { ...rest, zIndex } : rest;
      })
    : [];
  return { elementRules, elementZIndex, selectorRules };
}

function duplicateDefault(value) {
  if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
