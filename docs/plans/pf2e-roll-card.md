# PF2e roll card: implementation plan

Status: draft for review. No code until approved.
Mockup (approved direction, rev 2): https://claude.ai/artifact/VpV9xJwQbFtcRDwfyavQtD

## Goal

On the stream client, replace cloned Foundry chat cards for PF2e with a compact Hairline card. The card shows the player, character, portrait, action, target, natural d20, DC, total, degree of success and merged damage. Crits and crit fails play the Broken-condition crack shader inside the card. Other game systems keep today's cloned card.

## Decisions (from the grilling session, 2026-09-16)

| Area | Decision |
|---|---|
| Scope | d20 checks (attack, skill, save, perception, flat, initiative, counteract), spell casts, action posts with no roll, damage rolls. Every other PF2e message is hidden on stream. |
| Visibility | Public player rolls. Public GM rolls get an NPC variant: token image, no player name, name follows PF2e's name-visibility setting, DC never shown. A player's own blind roll shows its real result, and the card stays violet whatever the outcome, with a Blind chip, a dashed hairline and violet cracks on a crit. Every other blind, GM-only or whispered message is hidden. |
| Content | Player, character, action and target on one line, MAP tag, a d20 icon with the natural value large and centred, a large DC number, the total, and the degree label. All text has a strong drop shadow. No DC means the label reads "Result" with an off-white hairline. |
| Reveal order | The card enters neutral. The outcome colour, degree label, die tint and cracks land only after the total finishes counting. |
| Spell cast | Spell name large on the right. Below it, "DC X · <save>" or "Spell attack +N". Hairline in the tradition colour. |
| Merging | Damage merges into an on-screen card when its `flags.pf2e.origin` item and actor match and it arrives within 60s. A merge resets the card timer. Spells chain in place: cast, then attack, then damage. Group saves are not collapsed. |
| Damage row | Slides down under the card, with PF2e damage-type icons and amounts, the total, and a "CRIT ×2" tag. |
| Crits | Gold cracks for critical success, red for critical failure. A no-DC nat 20 or nat 1 also cracks. Cracks stay and pulse while the card is up. A merged damage row inherits the fracture. Damage on its own card gets a gold number pop, no cracks. |
| Rerolls | Update the card in place with a Reroll tag, and replay the result. Cracks are added, swapped or removed to match the new outcome. |
| Fallbacks | No WebGL: glowing hairline, no cracks. Reduced motion is ignored for this card (always animate). |
| Settings | Existing `lifetimeMs` and `maxVisible` stay. New `critLifetimeMultiplier` (default 1.5). No sound. |
| Styling | Etched Glass tokens and fonts copied into this module as a snapshot. The crack shader is copied from `gluniverse-foundry-modules/scripts/core/fx-glsl.mjs`. This module does not depend on the sibling module at runtime. |

## Architecture

```
renderChatMessageHTML / updateChatMessage / deleteChatMessage
        │
ChatOverlay (existing)  ── game.system.id !== "pf2e" ──▶ existing clone path (unchanged)
        │ pf2e
        ▼
pf2e/read-message.js   (pure)  message-like object ──▶ RollCardModel | {kind:"merge"} | null
        │
pf2e/roll-card-feed.js         routing: new card, merge into card, update card (reroll/chain), hide
        │
cards/roll-card.js             DOM + entrance/climax/update/addDamage animations (anime.js engine)
        │
fx/crack-renderer.js           one offscreen PIXI.Renderer + FX_FRAG_BREAK, blits into card canvases
```

### New files

- `scripts/pf2e/read-message.js`: a pure function, with no `game` access. It takes a plain snapshot (`{flags, rolls, author, speaker, blind, whisper, ...}`, built by a thin adapter) and returns:
  ```js
  { id, kind: "check"|"damage"|"cast"|"action", originKey, isReroll,
    actor: { name, img, isNpc }, player: { name } | null, visibility: "public"|"ownBlind",
    action: { label, sub, map }, target: { name } | null,
    roll: { natural, total, dc, dcVisible, degree: 0..3 | null },
    spell: { name, tradition, rank, line } | null,
    damage: { total, parts: [{ type, amount }], crit } | null,
    fx: "gold"|"red"|"pop"|null }
  ```
- `scripts/pf2e/snapshot.js`: turns a live `ChatMessagePF2e` into the plain snapshot. It resolves the portrait (token texture, falling back to `actor.img`, the same rule PF2e uses in `renderHTML`), the target (`message.target`), `message.item` for spells, and name visibility (`game.pf2e.settings.tokens.nameVisibility` or its v8.4 equivalent, to verify).
- `scripts/pf2e/roll-card-feed.js`: keeps `cardsByOriginKey` with timestamps. It applies the merge rule, dispatches reroll and chain updates, and enforces `maxVisible` and the lifetime with the crit multiplier.
- `scripts/cards/roll-card.js`: the Hairline card component, ported from the mockup's `RollCard` onto `scripts/motion/engine.js` (anime.js) instead of WAAPI, and ignoring `prefersCalmMotion`.
- `scripts/fx/crack-glsl.js`: a verbatim copy of `FX_GLSL_NOISE`, `FX_GLSL_BREAK_FIELD`, `FX_GLSL_BREAK_PULSE` and `FX_FRAG_BREAK`, with `dense` and `reach` promoted to uniforms. The header comment names the source file and commit.
- `scripts/fx/crack-renderer.js`: modelled on `CardFXManager`. One offscreen `PIXI.Renderer({backgroundAlpha:0})`, a sprite with the break filter, 1.25x supersample, a 30fps cap, per-card seed and impact, and blitting to each card's `<canvas>`. It stops the ticker when no cards are cracked. If WebGL is unavailable it reports `ok:false`.
- `styles/etched-glass.css`: a token snapshot, only the tokens the card uses.
- `styles/roll-card.css`: the card styles from the mockup.
- `assets/fonts/oxanium/*` and `jetbrains-mono/*` with their licences, plus `@font-face` rules.
- `assets/icons/d20.svg`. Damage-type icons come from PF2e's own assets. The paths need checking in `systems/pf2e`.
- `tests/pf2e-read-message.test.mjs`, with fixtures in `tests/fixtures/pf2e/*.json`.

### Changed files

- `scripts/chat-overlay.js`: route to the feed when `game.system.id === "pf2e"`. Keep the cloned path for other systems. Share placement, stacking and removal.
- `scripts/constants.js` and `scripts/settings.js`: add `critLifetimeMultiplier`.
- `templates/director.hbs` and `scripts/director-app.js`: add a crit multiplier field next to lifetime.
- `module.json`: add the new styles.
- `lang/en.json`: labels (degrees, "Result", "Blind", "Reroll", "Damage", "Unknown creature").
- `STREAM_MODULE_SPEC.md`: add a "PF2e roll card" section, and say the rebuild ban applies to systems without an adapter.
- `README.md`: a short feature note.

## Build order

Each step is its own commit, subject line only.

1. **Fixtures.** Capture real PF2e 8.4 messages from a test world with a small console snippet and save them as JSON. Cover an attack at MAP 0 and at MAP −5, damage, a crit and its damage, a save, a no-DC skill roll, a spell attack, a save spell, an NPC roll, a player's blind roll, a GM secret roll, a whisper, a hero point reroll, an action post, and initiative.
2. **`read-message.js` and tests.** Test the degree, natural, no-DC and visibility rules, the origin key, spell lines, damage parts, and the fx choice.
3. **Crack renderer.** Build the shader copy and the offscreen PIXI renderer. Check it with a temporary console harness on the stream client, then remove the harness.
4. **Card component and CSS.** Port the mockup onto the anime.js engine, with the d20 icon, spell block, blind chip, damage row, and the WebGL fallback.
5. **Feed and routing.** Merge, chain, reroll, lifetime with crit multiplier, `maxVisible`, delete handling, and Dice So Nice wait (reuse the existing `waitFor3D…` path).
6. **Settings and Director.** Add `critLifetimeMultiplier` and its localisation.
7. **Spec and README.**
8. **Manual test pass** in a live world, recorded as a short checklist in the PR.

## Open risks to verify during build

- **Blind roll data on the stream client.** The stream client logs in as a non-GM user. For a blind message, check that `message.rolls` still reaches that client. If Foundry v14 strips the rolls for non-GM viewers, "reveal the player's own blind roll" needs the GM client to relay the result over the module socket (`scripts/socket.js`). That is a larger change, and I'll check with you before building it.
- **PF2e name visibility API** in 8.4 (the setting key and the per-token override).
- **Damage-type icon paths** in the PF2e system assets.
- **The crack at 6:1.** `dense` 0.42 and `reach` 2.2 were tuned in a browser mockup, so confirm them at the real 1080p card size.
- **Two PIXI renderers.** Foundry's canvas plus ours share the GPU. Watch memory in OBS, and fall back to the glow if context creation fails.

## Out of scope

- Other game systems.
- Group save collapsing.
- Sound.
- Initiative tracker integration.
