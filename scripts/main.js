import { MODULE_ID } from "./constants.js";
import { CameraController } from "./camera-controller.js";
import { ChatOverlay } from "./chat-overlay.js";
import { configureDirectorApp, addStreamSceneControl, renderDirectorApp } from "./director-app.js";
import { DialogOverlay } from "./dialog-overlay.js";
import { registerSettings } from "./settings.js";
import { registerSocket } from "./socket.js";
import { StreamMode } from "./stream-mode.js";
import { TokenTracking } from "./token-tracking.js";
import { UiDetector } from "./ui-detector.js";

const state = {};

Hooks.once("init", () => {
  registerSettings();
  registerKeybindings();
  loadTemplates([
    `modules/${MODULE_ID}/templates/director.hbs`,
    `modules/${MODULE_ID}/templates/start-prompt.hbs`
  ]);
});

Hooks.once("ready", async () => {
  state.streamMode = new StreamMode();
  state.tokenTracking = new TokenTracking();
  state.camera = new CameraController(state.streamMode, state.tokenTracking);
  state.chatOverlay = new ChatOverlay(state.streamMode);
  state.dialogOverlay = new DialogOverlay(state.streamMode);
  state.uiDetector = new UiDetector(state.streamMode);

  configureDirectorApp(state);
  registerSocket(state);
  state.tokenTracking.registerHooks();
  state.camera.registerHooks();
  state.chatOverlay.registerHooks();
  state.dialogOverlay.registerHooks();
  state.uiDetector.registerHooks();

  Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
    renderDirectorApp();
    if (!["streamUserId", "autoStartStreamUserIds"].includes(key)) return;
    if (state.streamMode?.isStreamUser) state.streamMode.promptIfNeeded();
    else state.streamMode?.deactivate({ notify: false });
  });
  Hooks.on(`${MODULE_ID}.clientStatus`, () => renderDirectorApp());
  Hooks.on(`${MODULE_ID}.uiDetectedChanged`, () => renderDirectorApp());

  await state.streamMode.promptIfNeeded();
});

Hooks.on("getSceneControlButtons", controls => addStreamSceneControl(controls));
Hooks.on("canvasReady", () => state.streamMode?.reportStatus());
Hooks.on("updateScene", (scene, changes) => {
  if (scene.id === canvas?.scene?.id && foundry.utils.hasProperty(changes, `flags.${MODULE_ID}`)) renderDirectorApp();
});

function registerKeybindings() {
  game.keybindings.register(MODULE_ID, "emergencyRestore", {
    name: "GLUNIVERSE_STREAM.keybindings.emergencyRestore.name",
    hint: "GLUNIVERSE_STREAM.keybindings.emergencyRestore.hint",
    editable: [{ key: "KeyS", modifiers: ["CONTROL", "ALT"] }],
    restricted: false,
    precedence: CONST.KEYBINDING_PRECEDENCE?.NORMAL,
    onDown: () => {
      state.streamMode?.toggleRestore();
      return true;
    }
  });
}
