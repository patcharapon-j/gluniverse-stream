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

function sanitizeCameraSettings(value) {
  const source = (value && typeof value === "object") ? value : {};
  const migrated = { ...source };
  if (!migrated.outOfCombatMode && source.nonCombatMode) migrated.outOfCombatMode = migrateCameraMode(source.nonCombatMode);
  if (!migrated.combatMode && source.mode) migrated.combatMode = source.mode === "combat" ? CAMERA_MODES.combatants : migrateCameraMode(source.mode);
  if (!migrated.sceneViewMode && source.sceneModeView) migrated.sceneViewMode = source.sceneModeView;
  return sanitizeObject(migrated, DEFAULT_CAMERA_SETTINGS);
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
  const selectorRules = Array.isArray(rules.selectorRules)
    ? rules.selectorRules.filter(rule => rule?.selector && ["allow", "block"].includes(rule.action))
    : [];
  return { elementRules, selectorRules };
}

function duplicateDefault(value) {
  if (foundry?.utils?.deepClone) return foundry.utils.deepClone(value);
  return JSON.parse(JSON.stringify(value));
}
