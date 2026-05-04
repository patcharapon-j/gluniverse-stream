# GLUniverse Stream

GLUniverse Stream is a Foundry VTT v13 module for running a clean OBS/browser-capture stream client. It hides core Foundry UI on a dedicated stream user, adds Director controls for GMs/trusted users, frames the canvas camera, and renders stream-safe chat and presentation overlays.

## Features

- Dedicated stream-user mode with local opt-in prompt.
- Optional "Always Enter Stream Mode" startup choice, configurable by a Stream Director.
- Director panel for stream start/stop, UI restore, camera settings, tracked tokens, chat settings, and overlay visibility rules.
- Camera modes for manual/free camera, full scene background, tracked tokens, visible party tokens, and visible combatants.
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
6. Use the Director panel to configure camera mode, tracked tokens, chat overlay placement and offset, dialog lifetime, and UI visibility.

## Camera Modes

- **Manual/free camera**: Does not move the stream camera.
- **Scene/full background**: Frames the full scene background using fit or fill.
- **Tracked token(s)**: Follows visible manually tracked tokens.
- **Party only**: Follows visible player-owned tokens plus any visible manually tracked tokens.
- **Visible combatants**: Follows visible combatants plus any visible manually tracked tokens.

## Packaging A Release

For a Foundry-installable GitHub release, publish these release assets:

- `module.json`
- `gluniverse-stream.zip`

The release `module.json` includes `manifest` and `download` URLs pointing at the release assets.

## Compatibility

- Foundry VTT: v13 minimum, v13 verified.
