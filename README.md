# GLUniverse Stream

GLUniverse Stream is a Foundry VTT v13/v14 module for running a clean OBS/browser-capture stream client. It hides core Foundry UI on a dedicated stream user, adds Director controls for GMs/trusted users, frames the canvas camera, draws combat targeting lines, and renders stream-safe chat and presentation overlays.

## Features

- Dedicated stream-user mode with local opt-in prompt.
- Optional "Always Enter Stream Mode" startup choice, configurable by a Stream Director.
- Director panel for stream start/stop, UI restore, camera settings, targeting lines, tracked tokens, chat settings, and overlay visibility rules.
- Camera modes for manual/free camera, full scene background, tracked tokens, visible party tokens, visible combatants, the active turn, and a spotlight on the active token.
- Spotlight flights: when the spotlight has somewhere to go, the camera zooms out, crosses the map and zooms back in as one smooth arc.
- Blended camera motion: a new framing part-way through a move redirects the current move instead of restarting it.
- Final Fantasy-style targeting lines in combat: a glowing arc with flowing chevrons from the active combatant to each token it targets, ending in a spinning reticle.
- Target-aware framing that widens the shot to hold both an attacker and the tokens it is targeting.
- The camera never blocks or interferes with token movement: it only reacts to committed updates, and it stays off the canvas while a drag or ruler is in progress.
- Stream-client-side camera visibility checks so fog/hidden-token visibility stays under Foundry's normal client rules.
- Chat overlay that clones Foundry-rendered chat cards, waits for Dice So Nice/final roll rendering, and avoids duplicate roll cards.
- Dialog, journal, handout, and image presentation overlay with automatic close timing.
- Targeted stream UI hiding with optional allow/block rules for floating UI.

## Installation

Install from Foundry's **Add-on Modules** screen using this manifest URL:

```text
https://github.com/patcharapon-j/gluniverse-stream/releases/latest/download/module.json
```

## Setup

1. Enable the module in your world.
2. Open the **Stream** scene control and launch **Stream Director**.
3. Select the dedicated stream user in **Stream user**.
4. Log in as that stream user in the browser or OBS capture client.
5. Accept the startup prompt, or choose **Always Enter Stream Mode** to skip the prompt on future startups.
6. Use the Director panel to configure camera mode, targeting lines, tracked tokens, chat overlay placement and offset, dialog lifetime, and UI visibility.

## Camera Modes

- **Manual/free camera**: Does not move the stream camera.
- **Scene/full background**: Frames the full scene background using fit or fill.
- **Tracked token(s)**: Follows visible manually tracked tokens.
- **Party only**: Follows visible player-owned tokens plus any visible manually tracked tokens.
- **Visible combatants**: Follows visible combatants plus any visible manually tracked tokens.
- **Active turn only**: Follows only the combatant whose turn it currently is, plus any visible manually tracked tokens. The camera moves to the next combatant on each turn change.
- **Spotlight active token**: In combat only. Centers the active combatant's token at a fixed spotlight zoom, widening only as far as needed (down to **Min zoom**) to keep that token's targets in frame.

### Camera Motion

- **Pan speed** is how fast the camera crosses the map, in grid squares per second. Very short and very long moves are clamped to a comfortable duration. It applies to every camera mode.
- **Travel zoom-out** (spotlight only) is how far the camera zooms out when the spotlight moves somewhere outside the middle of the screen, whether the active token moved or the turn passed to another token. The camera zooms out, crosses and zooms back in; longer trips zoom out further, up to this value. Moves that stay near the middle of the screen just pan. Set it to 1 to always pan.
- Moves blend: if the destination changes mid-flight, the camera heads for the new one without zooming back in first.
- **Keep targets in frame** widens the framing to include whatever the framed tokens are targeting, so an attack across the map keeps both ends of the action on screen. It applies to every token-following mode, including spotlight.
- Framing that would run past the edge of the canvas is not skipped: the camera moves as close to it as Foundry allows.

## Targeting Lines

During combat, a glowing line is drawn from the combatant whose turn it is to every token it targets. The line draws out from the attacker, a reticle pops onto the target, chevrons flow toward the target while it holds, and the line retracts when the target is cleared or the turn passes.

- **Colors** follow disposition: friendly to hostile, hostile to friendly, same side, and neutral/other each have their own color. Secret dispositions count as neutral, so a line never reveals a hidden allegiance.
- **Visible to** chooses who sees lines: everyone, GMs and the stream, or the stream only. Each client only draws lines between tokens it can see.
- **Intensity** scales the line width and glow.
- Each player can hide lines on their own screen with **Show Targeting Lines** in Configure Settings.

## Motion

All module animation, from camera flights to chat cards to targeting lines, runs on [anime.js](https://animejs.com). While a scene is loaded it is stepped in time with the canvas render.

Clients that ask for reduced motion (OS/browser setting) or have Foundry's photosensitive mode on get calm versions of the chat cards, dialogs and targeting lines. The stream camera does not change, since it is the directed shot; set **Travel zoom-out** to 1 for a calmer camera.

## Packaging A Release

For a Foundry-installable GitHub release, publish these release assets:

- `module.json`
- `gluniverse-stream.zip`

The release `module.json` includes `manifest` and `download` URLs pointing at the release assets.

## Compatibility

- Foundry VTT: v13 minimum, v14 verified.

## Credits

- [anime.js](https://github.com/juliangarnier/anime) 4.5.0 by Julian Garnier, MIT License, bundled in `scripts/vendor/`.
