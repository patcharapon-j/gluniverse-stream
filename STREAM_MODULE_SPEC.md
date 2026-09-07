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
- `uiRules`: selector and detected-element allow/block rules, plus per-element z-index overrides applied to allowed elements in stream mode.

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
    "excludeDefeated": true,
    "includeTargets": true,
    "spotlightZoom": 1,
    "spotlightPlayersOnly": false,
    "spotlightPullback": true,
    "spotlightPullbackFactor": 2,
    "spotlightPullbackDurationMs": 300
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
    "elementZIndex": {},
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
- Camera: mode, fallback mode, scene fit/fill, scene initial behavior, current-scene override, padding, zoom caps, follow duration, exclude defeated, travel zoom-out settings, keep-targets-in-frame, spotlight zoom and spotlight player filter.
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
- `activeTurn`: frame only the visible, non-hidden token of the combatant whose turn it currently is, plus that token's current targets and any visible manually tracked tokens. The frame advances to the next combatant on each turn change.
- `spotlight`: in-combat only. Center the visible, non-hidden token of the combatant whose turn it currently is and set the canvas to `spotlightZoom` exactly. This mode overrides fit/fill bounds framing and the `minZoom`/`maxZoom` caps, so the framing distance is identical on every turn. Manually tracked tokens are not unioned in, because spotlight is single-token framing. `spotlightPlayersOnly` restricts the spotlight to player-owned tokens. When there is no eligible spotlight token the camera falls back to `combatants` framing, then to the scene.

Target framing (`includeTargets`):

- A token's targets are the tokens currently targeted by the users that control it: the player owners of its actor, or the active GMs when no player owns it. Targeting is per-user state in Foundry, so this is read from the users, never written.
- Only visible, non-hidden target tokens are framed, under the same visibility rule as every other camera target.
- Every token-following mode (`party`, `trackedToken`, `combatants`, `activeTurn`) unions the targets of the tokens it frames into its bounds.
- `spotlight` widens from `spotlightZoom` only as far as needed to hold the active token and its targets, and never past `minZoom`. With no targets the framing is unchanged: the active token centered at exactly `spotlightZoom`.
- A `targetToken` hook triggers a reframe.

Camera motion:

- The camera runs one continuous, critically damped motion loop rather than per-request tweens. Position and log-zoom each keep their velocity between frames, so retargeting mid-flight (a turn change during a pan, a token moving again while the camera is still travelling) bends the current move instead of restarting it.
- `animationDurationMs` is the smoothing time: roughly how long the camera takes to reach a new framing. `0` applies the framing instantly.
- Travel zoom-out (`spotlightPullback`, `spotlightPullbackFactor`, `spotlightPullbackDurationMs`) applies to every token-following mode, not just spotlight. The pull-back is proportional to how far the camera still has to travel, measured against the visible span of the canvas, so short moves barely pull back and cross-map moves pull back to `targetZoom / spotlightPullbackFactor` and ease back in on arrival. `spotlightPullbackDurationMs` is how quickly that zoom-out eases in and out. The transition is skipped when it is disabled or when the factor is not greater than 1.
- Camera destinations are clamped to what the canvas can actually display before the motion starts, using the same constraints Foundry applies. A framing that would scroll past the edge of the canvas is never skipped or refused: the camera settles as close to it as the canvas allows.

Token movement safety:

- The camera never runs from `preUpdateToken` or any other pre-update hook, and it never moves the canvas synchronously from inside a hook. Reframes are queued and applied on a later animation frame, so module camera work can never interleave with, delay, or cancel a token movement.
- While a canvas interaction is in progress on the stream client (token drag, ruler, placement preview), the camera holds its position and retries on the next frame instead of moving the canvas out from under the interaction.

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
- Target changes (`targetToken`).
- Combat creation, start, end, turn/round changes, combat update, and combatant add/remove/defeated changes. In-combat detection scans the combats collection for an active encounter on the current scene rather than relying on `game.combat`/`combats.viewed`, which is unreliable for the stream client because its combat tracker UI is hidden and some systems (e.g. D&D5e, PF2e) bind combats to a scene.
- Director reframe request. Explicit Director reframes may frame the scene when the active mode is manual or has no eligible visible token target. An explicit Director reframe always re-applies the camera: it cancels any in-flight pan animation and bypasses the same-target dedup so the request is never silently dropped.

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
