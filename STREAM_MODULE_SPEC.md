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
- Manually tracked tokens are scene-local flags, not actor data and not world-level token maps.
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
- Manages scene-local tracked tokens.

Trusted non-GM Directors cannot write world settings or scene flags directly. Their changes are relayed over a module socket to one active GM, which validates that the requester is still a Director before writing.

### Regular Users

Regular users see no module UI and experience no UI hiding. Depending on the targeting settings they may see combat targeting lines, which they can hide for themselves with a client setting.

## Data Model

World settings:

- `streamUserId`: string user id or empty string.
- `trustedDirectorUserIds`: array of user ids.
- `autoStartStreamUserIds`: array of stream user ids that skip the start prompt.
- `cameraSettings`: global camera settings.
- `chatSettings`: global chat overlay settings.
- `dialogSettings`: global dialog overlay settings.
- `targetingSettings`: global combat targeting line settings.
- `uiRules`: selector and detected-element allow/block rules, plus per-element z-index overrides applied to allowed elements in stream mode.

Client settings:

- `showTargetLines`: boolean, default `true`. Lets each client hide targeting lines locally.

Scene flags under `gluniverse-stream`:

- `trackedTokenIds`: array of token document ids for manual token tracking.

Default settings:

```json
{
  "cameraSettings": {
    "outOfCombatMode": "scene",
    "combatMode": "combatants",
    "sceneViewMode": "fitBackground",
    "paddingPercentTop": 10,
    "paddingPercentRight": 10,
    "paddingPercentBottom": 10,
    "paddingPercentLeft": 10,
    "paddingGridSpacesTop": 0,
    "paddingGridSpacesRight": 0,
    "paddingGridSpacesBottom": 0,
    "paddingGridSpacesLeft": 0,
    "minZoom": 0.5,
    "maxZoom": 1.5,
    "panSpeed": 12,
    "excludeDefeated": true,
    "includeTargets": true,
    "spotlightZoom": 1,
    "travelZoomOut": 2,
    "spotlightPlayersOnly": false
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
  "targetingSettings": {
    "enabled": true,
    "visibility": "everyone",
    "colorFriendlyToHostile": "#4db8ff",
    "colorHostileToFriendly": "#ff4a5c",
    "colorSameSide": "#52f5a0",
    "colorOther": "#ffd35c",
    "intensity": 1
  },
  "uiRules": {
    "elementRules": {},
    "elementZIndex": {},
    "selectorRules": []
  }
}
```

Camera settings are rebuilt from the default keys when read, which migrates older worlds: `nonCombatMode`/`mode`/`sceneModeView` map to the current mode keys, uniform `paddingPercent`/`paddingGridSpaces` expand to per-side padding, and `spotlightPullback` + `spotlightPullbackFactor` become `travelZoomOut` (`1` when the pull-back was disabled). The removed `animationDurationMs`, `spotlightPullbackDurationMs` and `sceneInitialView` keys are dropped.

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
- Camera: in-combat and out-of-combat modes, scene fit/fill, padding, zoom caps, exclude defeated, pan speed, keep-targets-in-frame, spotlight zoom, travel zoom-out and spotlight player filter.
- Targeting lines: enable, visible to, the four relationship colors, intensity.
- Tracking: current canvas tokens with manual track toggle.
- Chat overlay: position, x/y pixel offset, lifetime, max visible.
- Dialog overlay: lifetime.
- UI rules: best-effort detected UI and expert selector rules.

The Director is a control surface. It should not compute stream visibility-sensitive token eligibility.

## Animation

- All module animation runs on the module's own bundled anime.js engine (`scripts/vendor/anime.esm.min.js`), never Foundry's copy.
- While a canvas exists, the engine is stepped from the canvas ticker between Foundry's token animations and the canvas render, so camera moves and canvas effects land in the same frame the canvas draws. Without a canvas the engine uses its own loop.
- Calm motion applies on any client that prefers reduced motion (OS/browser) or has Foundry's photosensitive mode on. Chat cards, dialogs and targeting lines switch to plain fades with no scale, blur, sheen, light sweep or spin. The stream camera ignores calm motion.

## Camera

Camera movement runs only on the stream client while stream mode is active.

Modes:

- `scene`: frame scene background bounds.
- `manual`: do nothing automatically.
- `party`: frame visible, non-hidden tokens whose actors have player owners, plus visible tracked tokens.
- `trackedToken`: frame visible, non-hidden tokens whose token ids are in the current scene flag.
- `combatants`: frame visible, non-hidden combatant tokens on the current scene, excluding defeated combatants by default.
- `activeTurn`: frame only the visible, non-hidden token of the combatant whose turn it currently is, plus that token's current targets and any visible manually tracked tokens. The frame advances to the next combatant on each turn change.
- `spotlight`: in-combat only. Center the visible, non-hidden token of the combatant whose turn it currently is and set the canvas to `spotlightZoom` exactly. This mode overrides fit/fill bounds framing and the `minZoom`/`maxZoom` caps, so the framing distance is identical on every turn. Manually tracked tokens are not unioned in, because spotlight is single-token framing. `spotlightPlayersOnly` restricts the spotlight to player-owned tokens. When there is no eligible spotlight token the camera falls back to `combatants` framing, then to the scene.

Token destinations:

- The camera frames where a token is going, not where it is mid-animation: token bounds come from the document's committed `_source` position and size.

Target framing (`includeTargets`):

- A token's targets are the tokens currently targeted by the users that control it: the active player owners of its actor, or the active GMs when no active player owns it. Targeting is per-user state in Foundry, so this is read from the users, never written.
- Only visible, non-hidden target tokens are framed, under the same visibility rule as every other camera target.
- Every token-following mode (`party`, `trackedToken`, `combatants`, `activeTurn`) unions the targets of the tokens it frames into its bounds.
- `spotlight` widens from `spotlightZoom` only as far as needed to hold the active token and its targets, and never past `minZoom`. With no targets the framing is unchanged: the active token centered at exactly `spotlightZoom`.
- A `targetToken` hook triggers a reframe.

Camera motion:

- Each camera move is a layer whose clock anime.js animates. Every canvas frame the view is composed from the newest destination plus what remains of each layer's offset from the destination before it, and zoom is composed in log space. A new destination mid-move adds a layer instead of restarting, so position, zoom and velocity stay continuous; duplicate destinations are ignored.
- Move duration comes from `panSpeed` (grid squares per second) over the distance still to travel, with a zoom-change allowance, clamped to 0.35–2.5 s for glides and 1–3.6 s for flights.
- Every mode glides: position and zoom ease together.
- `spotlight` flies when the spotlight token's destination is outside the central half of the current screen (on either axis) and `travelZoomOut` is greater than 1: the camera zooms out, crosses while zoomed out and zooms back in, with the three phases overlapping into one arc. The zoom-out depth scales with the distance in screens, from half of `travelZoomOut` for a short hop up to all of it at two screens or more. Overlapping flights combine their zoom-out as a p-norm, so redirecting mid-flight stays zoomed out rather than zooming out twice.
- Camera destinations are clamped to what the canvas can actually display before the motion starts, using the same constraints Foundry applies. A framing that would scroll past the edge of the canvas is never skipped or refused: the camera settles as close to it as the canvas allows.
- Scene load and stream mode activation apply the framing instantly with no animation.

Token movement safety:

- The camera never runs from `preUpdateToken` or any other pre-update hook, and it never moves the canvas synchronously from inside a hook. Reframes are queued and applied on a later animation frame, so module camera work can never interleave with, delay, or cancel a token movement.
- While a canvas interaction is in progress on the stream client (token drag, ruler, placement preview), the camera holds its position (pausing any move in flight for up to 8 seconds) instead of moving the canvas out from under the interaction.

Visibility rule:

- Use currently available canvas token objects and their normal client visibility state.
- Do not inspect or bypass fog internals to include tokens the stream client cannot currently see.

Reframing triggers:

- Stream mode activation.
- Scene load.
- Relevant camera setting changes.
- Token create/delete/update affecting position, size, or hidden state.
- Manual tracked token changes.
- Target changes (`targetToken`).
- Combat creation, start, end, turn/round changes, combat update, and combatant add/remove/defeated changes. In-combat detection scans the combats collection for an active encounter on the current scene rather than relying on `game.combat`/`combats.viewed`, which is unreliable for the stream client because its combat tracker UI is hidden and some systems (e.g. D&D5e, PF2e) bind combats to a scene.
- Director reframe request. Explicit Director reframes may frame the scene when the active mode is manual or has no eligible visible token target.

## Targeting Lines

- Drawn on any client allowed by `targetingSettings.visibility` (`everyone`, `gmAndStream`, `streamOnly`) when `targetingSettings.enabled` and the client's `showTargetLines` are on.
- Only while a started combat exists on the canvas scene. Lines run from the active combatant's token to each token it targets, using the same controlling-user rule as target framing. A token targeting itself gets a reticle with no line.
- Player-controlled turns (the combatant's actor has at least one active non-GM owner): the owners' standing targets are drawn from the start of the turn, including targets picked before the turn began, and again whenever that combatant's turn comes back in a later round.
- GM-controlled turns (no active non-GM owner): targets any user already had when the turn began are carried over and not drawn, so a GM's selection is never reassigned from one NPC to the next, including the same NPC in a new round. A token becomes drawable again once it is targeted during the turn (a `targetToken` event). The first turn seen after load carries nothing over. Foundry targets are only read, never changed.
- Each client uses its own visibility: a line is drawn only when both tokens are visible and not hidden on that client.
- Color by disposition: friendly to hostile, hostile to friendly, same non-neutral side, and anything involving a neutral token. Secret disposition counts as neutral.
- Rendered as a PIXI container in `canvas.interface` at zIndex 1050, above token UI and rulers and below scrolling combat text. It holds three containers: `halo` (one shared blur filter, additive), `core` (normal blending, so the dark rim shows) and `glint` (additive, for the light sweep). Each line owns one Graphics in each and redraws them every canvas frame from the tokens' animated positions. The path buffer and drawing scratch are reused from frame to frame.
- Look ("Etched Bow"). Units: `u` is `max(0.5, intensity) / zoom^0.65` world units, and a hairline `hl` is one device pixel, `1 / (zoom × renderer resolution)`. Along the arc, in order: a blurred halo `14u` in the relationship colour, an etched rim `5u + 2hl` in INK (`#080a0e`) at 0.5, a tinted band `5u` at 0.3, a core `2u` at 0.85, and a bright hairline `hl` (the relationship colour mixed 65% toward white). The origin is a bright dot inside an INK ring. The head is a filled wedge 0.26 squares long and 0.22 wide that fades in over the last 18% of the reach and out within the first 15% of a retract (`headFadeOutMs`). The reticle sits at 1.12 of the target's half-size: a halo ring, an INK rim, a hairline ring and four quadrant marks. INK and white are the only fixed colours; everything else comes from the four relationship colours.
- Motion. A line launches in 600 ms (reach outCubic) while the reticle pops in from 1.6× its radius (outBack, starting 180 ms in). It retracts in 360 ms (inCubic), and a reticle whose target is gone collapses outwards in 220 ms. While a line holds, a single additive light sweep 0.6 squares long runs from source to target every 1.6 s, the glow breathes every 1.4 s, and the quadrant marks turn once every 6 s. Re-adding a line that is retracting reverses it. A canvas teardown clears lines instantly. Every duration is `TARGET_LINE_MOTION` in `scripts/constants.js`.
- Calm motion has no sweep, breathing, turning, spark or origin cue. Lines fade in over 420 ms and out over 320 ms.
- Turn changes normally retract the old combatant's lines while the new combatant's lines draw in, overlapping.
- Hand-off: when the turn passes between two different tokens of the same player and lines are still on screen, the change is sequential and keeps the target.
  - A target both tokens share keeps its line. The body retracts into the old source (`retractMs`, with the head gone within its first 15%), and the reticle dims to 45% with its loops frozen. After `handoffBeatMs`, the same line relaunches from the new source (`launchMs`), and the reticle brightens back to full.
  - A target that changes collapses as usual. A target new to this turn launches when the beat ends.
  - Whatever happens to the targets, one hairline ring sinks into the old token over the end of the retract (`originSinkMs`), and one rises out of the new token as its lines launch (`originRiseMs`). That is one ring per token per hand-off, not one per target, and never under calm motion.
  - Under calm motion the body fades out (`calmFadeOutMs`), waits `calmHandoffBeatMs` and fades back in, and the reticle still holds at 45%.
  - "Same player" compares the two tokens' turn players: the active non-GM users whose assigned character is the token's actor, or, when nobody has it assigned, its active non-GM owners. Two turns belong to the same player when those sets overlap.
    - Assignment comes first, so tables where every player owns every character still tell players apart.
    - A companion nobody has assigned belongs to its owners, so a player's character followed by their companion hands off. A mount several players own hands off from any of their characters.
    - GM-controlled tokens have no turn players, so NPC turns change over at once.
    - Which targets a line shows still follows the controlling-user rule above.
  - A turn change to a different acting token, or a canvas teardown, cancels a pending hand-off. A re-sort or insert that moves the turn index while the same token is still acting does not.
- Geometry lives in `scripts/targeting/target-geometry.js`, a pure module. At range the line is the same arc as before: a quadratic Bézier between the token centres, bowed left of travel by 0.16 of their distance (capped at 2.5 grid squares), cut to start 0.92 of the source's half-size along it and to stop at the reticle.
- Melee arch. Closeness `k` is `1 − edgeGap / 1.2 squares`, clamped to 0–1, where `edgeGap` is the centre distance minus 0.92 of the source's half-size and 1.12 of the target's.
  - Shoulder rule: the endpoints slide round the token edges towards the bow side by `55° × k`.
  - Hop: the control point sits off the shoulder-to-shoulder chord by `max(min(0.16 × chord, 2.5 squares), 0.9 squares × k)`, a mid-curve lift of at least `0.45 squares × k`.
  - The arch fully replaces the range arc by `k = 0.5` (an edge gap of 0.6 squares), and the two curves' control points blend in between, so the line never jumps as tokens close.
  - Results: side-by-side 1×1 tokens get about 1.0 square of body, diagonal 0.9, a 2×2 next to a 1×1 1.1. The head arrives within 30° of straight into the reticle, and the body never cuts inside it.
  - The bow stays left of travel, so two tokens on either side of one target arch on opposite sides.

## Token Tracking

- Token HUD tracking button is visible only to GMs.
- Director token list is visible to Directors.
- Toggling tracking writes `trackedTokenIds` on the current scene flag.
- Tracking is ignored after scene change unless that scene has its own tracked token flag.
- Actor documents are never modified for stream tracking.

## Chat Overlay

- Listen for Foundry's rendered chat HTML on the stream client.
- Clone the final rendered HTML into the module overlay.
- Do not rebuild system-specific chat cards, except for systems with a roll card adapter (PF2e, below).
- Each card expires independently.
- If visible cards exceed `maxVisible`, the oldest animates out.
- Position is one of `top-left`, `top-right`, `bottom-left`, `bottom-right`.
- `offsetX` and `offsetY` move the overlay in pixels from the selected position.

## PF2e Roll Card

In a PF2e world, the chat overlay does not clone chat cards. It builds a roll card from each new message (`createChatMessage`), and never from chat history re-rendered on load. Plan and decisions: `docs/plans/pf2e-roll-card.md`.

- `scripts/pf2e/snapshot.js` turns the message into a plain snapshot. `scripts/pf2e/read-message.js` (pure, tested against real PF2e 8.4 fixtures in `tests/fixtures/pf2e`) turns that into a card model, or nothing.
- Shown: d20 checks, spell casts, actions posted from a sheet, and damage rolls. Everything else is hidden.
- Visibility:
  - Public messages are shown.
  - A player's own blind roll is shown with its result, in violet with a Blind chip.
  - Every other blind, GM-only or whispered message is hidden. Foundry sends these rolls to every client, so the check is the module's.
- GM rolls use the NPC variant:
  - The token image, no player name, and the DC is never shown.
  - The creature and target names follow PF2e's name-visibility setting.
- The card enters neutral. Its outcome (colour, degree label, die tint, cracks) lands only after the total finishes counting.
- A check with no DC shows "Result". A natural 20 or 1 still cracks gold or red.
- Cracks:
  - Critical success cracks gold. Critical failure cracks red. A blind roll cracks violet.
  - The shader is `scripts/fx/crack-glsl.js`, copied from gluniverse-foundry-modules, and is drawn by one shared offscreen PIXI renderer.
  - If WebGL is unavailable, the card falls back to a glowing hairline.
- Merging:
  - Damage joins the on-screen card whose message has the same `flags.pf2e.origin.uuid`, within 60 seconds.
  - A check joins a cast card of the same spell.
  - Either merge restarts the card's lifetime.
- Rerolls: PF2e deletes the old message and posts a new one. The deleted check card waits 2 seconds for a reroll with the same speaker, check type and statistic, then rewrites itself with a Reroll chip.
- Lifetime and stacking: roll cards share `lifetimeMs` and `maxVisible` with cloned cards. Critical success and failure cards last `critLifetimeMultiplier` times longer (default 1.5).
- Roll cards ignore reduced-motion preferences.

### Portrait framing

- Card art is shown through a feathered frame. Which part of the picture shows is decided in this order:
  1. A GM's focus point, saved per image in the actor flag `portraitFocus` as `[{src, x, y, w}]`.
  2. A face found by MediaPipe's BlazeFace model.
  3. smartcrop's content-aware pick.
  4. The default crop: full width, near the top.
- A focus is `{x, y, w}` in image widths; the height follows from the art's 8.2:4.4 aspect (`scripts/framing/focus-math.js`, unit tested).
- Face detection:
  - Runs on the whole image and on zoomed windows over its upper 75%, so small faces in full-body art are found.
  - Overlapping hits merge into votes. A face needs a score of at least 0.75, or 3+ votes at 0.45 or more, and must sit in the top half of tall art.
  - PF2e iconics: faces found in 33/36 portraits and 31/36 tokens.
- Where it runs (`scripts/framing/portrait-framer.js`):
  - Only on the stream client, one image at a time, yielding between windows so animations do not hitch.
  - Results are cached in memory and in `localStorage`, keyed by image path. A load or CORS failure is not persisted.
  - Party members, player characters and combatants are pre-scanned when stream mode starts and when combat changes. A card whose art is not analysed yet shows the default crop and glides to its framing when the analysis lands.
- The GM edits focus points in Director → Frame Portraits (`scripts/framing/portrait-framing-app.js`): drag to pan, scroll or slider to zoom, with a live card preview.
- The vendored MediaPipe bundle carries one patch so its loader ignores Foundry's global `Module` (`scripts/vendor/mediapipe/PATCHES.md`).

## Dialog Overlay

- Detect dialog-like applications rendered on the stream client.
- Center the actual dialog element in the module overlay, animating it in.
- Auto-close after `dialogSettings.lifetimeMs`, animating it out before closing.
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
    combat-utils.js
    token-utils.js
    camera/
      controller.js
      framing.js
      motion.js
    motion/
      engine.js
    targeting/
      target-lines.js
      target-line.js
      target-geometry.js
    chat-overlay.js
    dialog-overlay.js
    ui-detector.js
    token-tracking.js
    socket.js
    vendor/
      anime.esm.min.js
      anime.LICENSE.md
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
- Scene load frames the current camera mode without animation.
- Combat/manual/player token camera modes only use tokens visible to the stream client.
- Spotlight moves outside the middle of the screen zoom out, cross and zoom back in; nearby moves pan.
- In combat, targeting lines connect the active combatant to its visible targets on every allowed client.
- Manual tracking writes scene flags only.
- Invalid UI selector rules do not throw user-visible errors or stop stream mode.
