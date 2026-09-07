# GLUniverse Stream

GLUniverse Stream is a Foundry VTT v13/v14 module for running a clean OBS/browser-capture stream client. It hides core Foundry UI on a dedicated stream user, adds Director controls for GMs/trusted users, frames the canvas camera, and renders stream-safe chat and presentation overlays.

## Features

- Dedicated stream-user mode with local opt-in prompt.
- Optional "Always Enter Stream Mode" startup choice, configurable by a Stream Director.
- Director panel for stream start/stop, UI restore, camera settings, tracked tokens, chat settings, and overlay visibility rules.
- Camera modes for manual/free camera, full scene background, tracked tokens, visible party tokens, and visible combatants.
- In-combat spotlight mode that locks a fixed zoom onto the active token.
- Continuous, velocity-preserving camera motion: a new framing part-way through a move bends the current move instead of restarting it, and the camera zooms out while it travels a long way and back in on arrival.
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
6. Use the Director panel to configure camera mode, tracked tokens, chat overlay placement and offset, dialog lifetime, and UI visibility.

## Camera Modes

- **Manual/free camera**: Does not move the stream camera.
- **Scene/full background**: Frames the full scene background using fit or fill.
- **Tracked token(s)**: Follows visible manually tracked tokens.
- **Party only**: Follows visible player-owned tokens plus any visible manually tracked tokens.
- **Visible combatants**: Follows visible combatants plus any visible manually tracked tokens.
- **Active turn only**: Follows only the combatant whose turn it currently is, plus any visible manually tracked tokens. The camera moves to the next combatant on each turn change.
- **Spotlight active token**: In combat only. Centers the active combatant's token at a fixed spotlight zoom, widening only as far as needed (down to **Min zoom**) to keep that token's targets in frame.

### Camera Motion

- **Follow ms** sets roughly how long the camera takes to reach a new framing. Motion is continuously eased and keeps its velocity across retargets, so turn changes and token moves during a pan stay smooth.
- **Travel zoom-out** pulls the camera back while it crosses a long distance and eases back in as it arrives, scaled by how far it has to travel. **Zoom-out factor** caps how far back it pulls; **Zoom-out ms** sets how quickly that eases in and out.
- **Keep targets in frame** widens the framing to include whatever the framed tokens are targeting, so an attack across the map keeps both ends of the action on screen. It applies to every token-following mode, including spotlight.
- Framing that would run past the edge of the canvas is not skipped: the camera moves as close to it as Foundry allows.

## Packaging A Release

For a Foundry-installable GitHub release, publish these release assets:

- `module.json`
- `gluniverse-stream.zip`

The release `module.json` includes `manifest` and `download` URLs pointing at the release assets.

## Compatibility

- Foundry VTT: v13 minimum, v14 verified.
