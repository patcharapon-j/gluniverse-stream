# GLUniverse Stream Module Specification

## Purpose

`gluniverse-stream` is a Foundry VTT v13 client-side module for running one dedicated browser session as an OBS capture client. The stream client keeps the canvas visible, hides normal Foundry chrome, shows stream-friendly overlays, and can automatically frame the canvas without changing world data used by normal players.

The module must be conservative. It must not alter permissions, token visibility, fog, scene data, actor data, or combat data to improve the stream view.

## Non-Negotiable Rules

- Exactly one Foundry user id can be configured as the stream user.
- Stream mode is local and session-only. It is not a persistent world state.
- The configured stream user must opt in each session with a Start / Cancel prompt.
- A Director may request that the stream user start, stop, restore UI, or reframe. A Director request must not bypass the stream user's normal visibility or fog.
- Visibility-sensitive camera target selection must run on the stream client only.
- Directors can configure settings, but the stream client applies those settings locally.
- Manually tracked tokens and per-scene camera overrides are scene-local flags, not actor data and not world-level token maps.
- Core Foundry UI is hidden by CSS while stream mode is active. The canvas remains visible and usable.
- Avoid hiding broad layout containers when narrower core selectors are available, because third-party modules may place UI inside Foundry layout regions.
- Third-party UI is visible by default unless blocked by a rule.

## Roles

### Stream User

The configured user id used by the OBS/browser capture session.

Behavior:

- On `ready`, if this client is the configured stream user, show a Start / Cancel prompt.
- Start activates stream mode for this client only.
- Cancel leaves Foundry unchanged for this session.
- `Ctrl+Alt+S` toggles emergency UI restore without disabling stream mode.
- Manual camera mode leaves canvas control to this client.

### Stream Director

All GMs plus configured trusted user ids.

Behavior:

- Sees the Stream scene control group.
- Opens the Director interface.
- Configures stream settings.
- Requests stream start/stop/restore/reframe commands.
- Manages scene-local tracked tokens and current-scene camera override.

Trusted non-GM Directors cannot write world settings or scene flags directly. Their changes are relayed over a module socket to one active GM, which validates that the requester is still a Director before writing.

### Regular Users

Regular users see no module UI and experience no UI hiding.

## Data Model

World settings:

- `streamUserId`: string user id or empty string.
- `trustedDirectorUserIds`: array of user ids.
- `cameraSettings`: global camera settings.
- `chatSettings`: global chat overlay settings.
- `dialogSettings`: global dialog overlay settings.
- `uiRules`: selector and detected-element allow/block rules.

Scene flags under `gluniverse-stream`:

- `trackedTokenIds`: array of token document ids for manual token tracking.
- `sceneCameraOverride`: object for current-scene camera behavior, currently `{ sceneInitialView }`.

Default settings:

```json
{
  "cameraSettings": {
    "mode": "combat",
    "nonCombatMode": "scene",
    "sceneModeView": "fitBackground",
    "sceneInitialView": "fillBackground",
    "paddingPercent": 10,
    "paddingGridSpaces": 0,
    "minZoom": 0.5,
    "maxZoom": 1.5,
    "animationDurationMs": 750,
    "excludeDefeated": true
  },
  "chatSettings": {
    "position": "top-left",
    "offsetX": 0,
    "offsetY": 0,
    "lifetimeMs": 10000,
    "maxVisible": 5
  },
  "dialogSettings": {
    "lifetimeMs": 10000
  },
  "uiRules": {
    "elementRules": {},
    "selectorRules": []
  }
}
```

## Stream Mode

When stream mode is active on the stream client:

- Add `gluniverse-stream-active` to `document.body`.
- Create one module-owned overlay root above the canvas.
- Hide core Foundry UI by CSS using curated selectors.
- Do not mutate Foundry documents to hide UI.
- Keep third-party UI visible unless an explicit block rule applies.
- Emergency restore adds `gluniverse-stream-restore`, which disables module hiding rules while stream mode remains active.

Director Start behavior:

- Sends a start request to the stream client.
- If the stream client is inactive, it shows the same Start / Cancel prompt.
- It does not silently force activation.

Director Stop behavior:

- Sends a stop request to the stream client.
- If stream mode is active, the stream client deactivates locally.

## Director Interface

The Director uses Foundry v13 `ApplicationV2` and every template part must render exactly one root HTML element.

Required sections:

- Status: stream user, connected state, last reported active state, current scene, camera mode.
- Session controls: request start, stop stream mode on the stream client, toggle normal Foundry UI visibility on the stream client, enable/revoke stream-user auto-start, reframe now.
- Users: select stream user and trusted Directors.
- Camera: mode, fallback mode, scene fit/fill, scene initial behavior, current-scene override, padding, zoom caps, animation duration, exclude defeated.
- Tracking: current canvas tokens with manual track toggle.
- Chat overlay: position, x/y pixel offset, lifetime, max visible.
- Dialog overlay: lifetime.
- UI rules: best-effort detected UI and expert selector rules.

The Director is a control surface. It should not compute stream visibility-sensitive token eligibility.

## Camera

Camera movement runs only on the stream client while stream mode is active.

Modes:

- `scene`: frame scene background bounds.
- `manual`: do nothing automatically.
- `players`: frame visible, non-hidden tokens whose actors have player owners.
- `manualTokens`: frame visible, non-hidden tokens whose token ids are in the current scene flag.
- `combat`: frame visible, non-hidden combatant tokens on the current scene, excluding defeated combatants by default.

Visibility rule:

- Use currently available canvas token objects and their normal client visibility state.
- Do not inspect or bypass fog internals to include tokens the stream client cannot currently see.

Scene initial view:

- On `canvasReady`, apply scene initial view instantly with no animation.
- Current-scene flag override wins over global setting.
- Default is `fillBackground`.

Reframing triggers:

- Stream mode activation.
- Scene load.
- Relevant camera setting changes.
- Token create/delete/update affecting position, size, or hidden state.
- Manual tracked token changes.
- Combat start, turn/round changes, combat update, and combatant defeated changes.
- Director reframe request. Explicit Director reframes may frame the scene when the active mode is manual or has no eligible visible token target.

## Token Tracking

- Token HUD tracking button is visible only to GMs.
- Director token list is visible to Directors.
- Toggling tracking writes `trackedTokenIds` on the current scene flag.
- Tracking is ignored after scene change unless that scene has its own tracked token flag.
- Actor documents are never modified for stream tracking.

## Chat Overlay

- Listen for Foundry's rendered chat HTML on the stream client.
- Clone the final rendered HTML into the module overlay.
- Do not rebuild system-specific chat cards.
- Each card expires independently.
- If visible cards exceed `maxVisible`, remove the oldest.
- Position is one of `top-left`, `top-right`, `bottom-left`, `bottom-right`.
- `offsetX` and `offsetY` move the overlay in pixels from the selected position.

## Dialog Overlay

- Detect dialog-like applications rendered on the stream client.
- Center the actual dialog element in the module overlay.
- Auto-close after `dialogSettings.lifetimeMs`.
- If closing throws because the application is already gone, catch and ignore/log.

This is intentionally aggressive for OBS safety. Future versions may support allowlisted persistent dialogs.

## UI Rules

MVP behavior:

- Core UI is hidden by curated CSS selectors.
- Detected floating UI is best-effort metadata for Directors.
- Third-party and unknown floating UI remains visible by default.
- Explicit block rules hide matching elements.
- Explicit allow rules override core hiding only when the allow class is placed on the exact hidden element.
- Invalid expert selectors must be caught and must not break stream mode.

Conflict order:

1. Emergency restore.
2. Explicit allow/block rules.
3. Core curated hiding.
4. Default visible.

## File Structure

```text
gluniverse-stream/
  module.json
  STREAM_MODULE_SPEC.md
  scripts/
    main.js
    constants.js
    settings.js
    stream-mode.js
    director-app.js
    camera-controller.js
    chat-overlay.js
    dialog-overlay.js
    ui-detector.js
    token-tracking.js
    socket.js
  styles/
    stream.css
  templates/
    director.hbs
    start-prompt.hbs
  lang/
    en.json
```

## Acceptance Criteria

- Only the configured stream user receives the Start / Cancel prompt.
- Cancel leaves Foundry unchanged for that session.
- Director Start requests a prompt; it does not silently force activation.
- Stream mode hides core UI and keeps canvas visible.
- `Ctrl+Alt+S` restores/hides UI without changing stream mode state.
- GMs and trusted Directors see the Stream scene control; others do not.
- Director setting changes update the stream client automatically.
- Chat messages visible to the stream client appear as cloned overlay cards and expire.
- Dialog-like apps on the stream client center and auto-close.
- Scene initial view fills the background by default without animation.
- Combat/manual/player token camera modes only use tokens visible to the stream client.
- Manual tracking writes scene flags only.
- Invalid UI selector rules do not throw user-visible errors or stop stream mode.
