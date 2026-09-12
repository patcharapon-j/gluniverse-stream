export const MODULE_ID = "gluniverse-stream";
export const SOCKET_NAME = `module.${MODULE_ID}`;

export const CLASSES = {
  active: "gluniverse-stream-active",
  restore: "gluniverse-stream-restore",
  overlayRoot: "gluniverse-stream-overlay-root",
  chatRoot: "gluniverse-stream-chat-root",
  dialogRoot: "gluniverse-stream-dialog-root",
  blockedUi: "gluniverse-stream-ui-blocked",
  allowedUi: "gluniverse-stream-ui-allowed",
  centeredDialog: "gluniverse-stream-centered-dialog",
  imagePresentation: "gluniverse-stream-image-presentation",
  journalPresentation: "gluniverse-stream-journal-presentation",
  manualCloseDialog: "gluniverse-stream-manual-close-dialog",
  dialogRootInteractive: "gluniverse-stream-dialog-root-interactive"
};

export const FLAGS = {
  trackedTokenIds: "trackedTokenIds",
  sceneCameraOverride: "sceneCameraOverride"
};

export const CAMERA_MODES = {
  manual: "manual",
  scene: "scene",
  trackedToken: "trackedToken",
  party: "party",
  combatants: "combatants",
  activeTurn: "activeTurn",
  spotlight: "spotlight"
};

export const SCENE_VIEW_MODES = {
  fitBackground: "fitBackground",
  fillBackground: "fillBackground"
};

export const CHAT_POSITIONS = ["top-left", "top-right", "bottom-left", "bottom-right"];

export const DEFAULT_CAMERA_SETTINGS = {
  outOfCombatMode: CAMERA_MODES.scene,
  combatMode: CAMERA_MODES.combatants,
  sceneViewMode: SCENE_VIEW_MODES.fitBackground,
  paddingPercentTop: 10,
  paddingPercentRight: 10,
  paddingPercentBottom: 10,
  paddingPercentLeft: 10,
  paddingGridSpacesTop: 0,
  paddingGridSpacesRight: 0,
  paddingGridSpacesBottom: 0,
  paddingGridSpacesLeft: 0,
  minZoom: 0.5,
  maxZoom: 1.5,
  /** Grid squares per second. */
  panSpeed: 12,
  excludeDefeated: true,
  includeTargets: true,
  spotlightZoom: 1,
  /** Spotlight only: how far a flight zooms out at most. 1 turns flights off. */
  travelZoomOut: 2,
  spotlightPlayersOnly: false
};

export const DEFAULT_CHAT_SETTINGS = {
  position: "top-left",
  offsetX: 0,
  offsetY: 0,
  lifetimeMs: 10000,
  maxVisible: 5
};

export const DEFAULT_DIALOG_SETTINGS = {
  lifetimeMs: 10000
};

export const TARGET_LINE_VISIBILITY = {
  everyone: "everyone",
  gmAndStream: "gmAndStream",
  streamOnly: "streamOnly"
};

export const DEFAULT_TARGETING_SETTINGS = {
  enabled: true,
  visibility: TARGET_LINE_VISIBILITY.everyone,
  colorFriendlyToHostile: "#4db8ff",
  colorHostileToFriendly: "#ff4a5c",
  colorSameSide: "#52f5a0",
  colorOther: "#ffd35c",
  /** Line width and glow multiplier, 0.25 to 2. */
  intensity: 1
};

export const DEFAULT_UI_RULES = {
  elementRules: {},
  elementZIndex: {},
  selectorRules: []
};

export const SOCKET_TYPES = {
  clientStatus: "clientStatus",
  requestClientStatus: "requestClientStatus",
  command: "command",
  requestSettingSet: "requestSettingSet",
  requestSceneFlagSet: "requestSceneFlagSet",
  requestAutoStartSet: "requestAutoStartSet"
};

export const STREAM_COMMANDS = {
  start: "start",
  stop: "stop",
  toggleRestore: "toggleRestore",
  reframe: "reframe"
};

export const CORE_UI_SELECTORS = [
  "#sidebar",
  "#sidebar-tabs",
  "#chat",
  "#chat-log",
  "#chat-form",
  "#chat-message",
  "#chat-controls",
  "#chat-notifications",
  "#controls",
  "#scene-controls",
  "#navigation",
  "#scene-navigation",
  "#nav-toggle",
  "#scene-list",
  "#hotbar",
  "#players",
  "#pause",
  "#menu",
  "#logo",
  "#notifications",
  ".chat-sidebar",
  ".chat-form",
  ".chat-input",
  ".chat-message-input",
  ".scene-control",
  ".scene-controls",
  ".scene-navigation",
  ".scene-nav",
  ".scene-list",
  ".control-tool",
  ".token-hud",
  "#token-hud",
  "#measurement-hud",
  "#tooltip"
];
