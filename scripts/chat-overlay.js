import { CLASSES, MODULE_ID } from "./constants.js";
import { animate, prefersCalmMotion, remove } from "./motion/engine.js";
import { waitForDiceAnimation } from "./dice-wait.js";
import { RollCardFeed } from "./pf2e/roll-card-feed.js";
import { getChatSettings } from "./settings.js";

/** Where cards slide in from and out to, per overlay corner, in pixels. */
const CARD_OFFSETS = {
  "top-left": { enterX: -56, enterY: -4, exitX: -42, exitY: -2 },
  "top-right": { enterX: 56, enterY: -4, exitX: 42, exitY: -2 },
  "bottom-left": { enterX: -56, enterY: 4, exitX: -42, exitY: 2 },
  "bottom-right": { enterX: 56, enterY: 4, exitX: 42, exitY: 2 }
};
const SHEEN_DELAY_MS = 380;

export class ChatOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.cards = [];
    this.cardsByMessageId = new Map();
    this.feed = new RollCardFeed(this);
  }

  registerHooks() {
    // PF2e gets its own roll cards, built from new messages only, never from re-rendered history.
    Hooks.on("createChatMessage", message => {
      if (!this.streamMode.active || !usesRollCards()) return;
      this.feed.handleCreate(message).catch(error => console.error(`${MODULE_ID} | Roll card failed`, error));
    });
    Hooks.on("renderChatMessageHTML", (message, html) => this.handleRenderedMessage(message, html));
    Hooks.on("updateChatMessage", message => this.handleMessageUpdate(message));
    Hooks.on("deleteChatMessage", message => this.handleMessageDelete(message));
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (key === "chatSettings") this.applySettings();
    });
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => {
      if (active) {
        this.applySettings();
        if (usesRollCards()) this.feed.prescan();
      } else this.clear();
    });
    // New combatants are the next people to roll: frame their art ahead of time.
    const prescan = () => {
      if (this.streamMode.active && usesRollCards()) this.feed.prescan();
    };
    Hooks.on("createCombatant", prescan);
    Hooks.on("combatStart", prescan);
    Hooks.on("canvasReady", prescan);
  }

  handleRenderedMessage(message, html) {
    if (!this.streamMode.active || usesRollCards()) return;
    if (!isAudienceVisible(message)) return;
    const source = getElement(html);
    if (!source) return;
    // Modules such as RSReforged run transient/preview renders through
    // renderChatMessageHTML while processing a roll: unsaved ChatMessage husks with
    // no world id, timestamp 0 and empty content. A player's chat log never shows
    // these as cards, so neither should the stream — only mirror messages that
    // actually exist in the world.
    if (!isPersistedMessage(message, source)) return;
    const messageId = message?.id ?? message?.uuid ?? source.dataset.messageId ?? source.dataset.messageUuid;

    if (messageId) {
      const existing = this.cardsByMessageId.get(messageId);
      if (existing) {
        if (existing.element?.isConnected) this.refreshCardContents(existing, message, source);
        return;
      }
    }

    const placeholder = { pending: true, messageId };
    if (messageId) this.cardsByMessageId.set(messageId, placeholder);
    this.createCardAfterDice(message, source, messageId, placeholder);
  }

  handleMessageUpdate(message) {
    if (!this.streamMode.active || usesRollCards()) return;
    const id = message?.id;
    if (!id) return;
    const record = this.cardsByMessageId.get(id);
    if (!record?.element?.isConnected) return;
    window.requestAnimationFrame(() => {
      const latest = getLatestRenderedMessage(null, message, id);
      if (latest) this.refreshCardContents(record, message, latest);
    });
  }

  handleMessageDelete(message) {
    const id = message?.id;
    if (!id) return;
    if (usesRollCards() && this.feed.handleDelete(message)) return;
    const record = this.cardsByMessageId.get(id);
    // Mark the record so an in-flight createCardAfterDice (still awaiting the dice
    // animation) aborts instead of building a card for a message that no longer
    // exists — e.g. RSReforged merges a damage roll into the parent attack card and
    // then deletes the transient child message.
    if (record) record.cancelled = true;
    if (record?.element?.isConnected) this.removeCard(record.element);
    else if (record) this.cardsByMessageId.delete(id);
  }

  async createCardAfterDice(message, source, messageId, placeholder) {
    await waitForDiceAnimation(message);
    await nextFrame();
    // A bundling system (e.g. RSReforged) can merge this roll into another card and
    // delete the message while we were waiting on the dice. Bail out if it was
    // cancelled by a delete, or no longer exists in the world, so we don't emit a
    // duplicate/orphan card for content that already lives in the bundled card.
    const stillExists = !messageId || Boolean(game.messages?.get?.(messageId));
    if (!this.streamMode.active || placeholder?.cancelled || !stillExists) {
      if (messageId && this.cardsByMessageId.get(messageId) === placeholder) this.cardsByMessageId.delete(messageId);
      return;
    }

    const latest = getLatestRenderedMessage(source, message, messageId) ?? source;
    if (!latest) {
      if (messageId && this.cardsByMessageId.get(messageId) === placeholder) this.cardsByMessageId.delete(messageId);
      return;
    }

    const settings = getChatSettings();
    const root = this.streamMode.getChatRoot();
    this.applySettings();

    const card = document.createElement("div");
    card.className = `gluniverse-stream-chat-card ${CHAT_CONTEXT_CLASS}`;
    if (messageId) card.dataset.streamMessageId = messageId;
    card.append(this.buildClone(latest, message));
    const sheen = document.createElement("span");
    sheen.className = "gluniverse-stream-chat-sheen";
    card.append(sheen);
    applyThemeContext(card, latest);
    card.style.maxHeight = "0px";
    card.style.opacity = "0";
    root.append(card);

    const record = {
      element: card,
      sheen,
      messageId,
      phase: "entering",
      timeout: window.setTimeout(() => this.removeCard(card), Math.max(0, Number(settings.lifetimeMs) || 0))
    };
    this.cards.push(record);
    if (messageId) this.cardsByMessageId.set(messageId, record);
    this.mirrorLiveSource(record, latest, message);

    window.requestAnimationFrame(() => this.animateCardIn(record, settings.position));
    this.enforceMaxVisible();
  }

  /** When more cards are up than `maxVisible` allows, the oldest leave. */
  enforceMaxVisible() {
    const max = Math.max(1, Number(getChatSettings().maxVisible) || 5);
    while (this.cards.length > max) this.removeCard(this.cards[0].element);
  }

  /**
   * The card unfolds to its content height while it slides in from its corner, scales up with a slight
   * overshoot and comes into focus; the sheen sweeps across once it has mostly arrived.
   */
  animateCardIn(record, position) {
    const card = record.element;
    if (!card?.isConnected || record.phase !== "entering") return;
    const height = `${card.scrollHeight}px`;
    const settle = () => {
      if (record.phase !== "entering") return;
      record.phase = "shown";
      this.trackCardHeight(record);
      this.syncCardHeight(record);
    };

    if (prefersCalmMotion()) {
      animate(card, { opacity: [0, 1], duration: 180, ease: "linear" });
      animate(card, { maxHeight: ["0px", height], duration: 220, ease: "linear", onComplete: settle });
      return;
    }

    const offsets = CARD_OFFSETS[position] ?? CARD_OFFSETS["top-left"];
    animate(card, { maxHeight: ["0px", height], duration: 520, ease: "outQuint", onComplete: settle });
    animate(card, { opacity: [0, 1], duration: 360, ease: "outQuint" });
    animate(card, {
      translateX: [`${offsets.enterX}px`, "0px"],
      translateY: [`${offsets.enterY}px`, "0px"],
      scale: [0.92, 1],
      duration: 620,
      ease: "outBack(1.2)"
    });
    animate(card, {
      "--stream-chat-blur": ["3px", "0px"],
      "--stream-chat-shadow": [0.35, 1],
      duration: 420,
      ease: "outQuint"
    });
    animate(record.sheen, { translateX: ["-130%", "140%"], duration: 1400, delay: SHEEN_DELAY_MS, ease: "outQuint" });
    animate(record.sheen, {
      opacity: [{ from: 0, to: 0.9, duration: 250 }, { to: 0, duration: 1150 }],
      delay: SHEEN_DELAY_MS,
      ease: "linear"
    });
  }

  refreshCardContents(record, message, source) {
    const card = record?.element;
    if (!card?.isConnected) return;
    const latest = getLatestRenderedMessage(source, message, record.messageId) ?? source;
    if (!latest) return;
    if (latest !== record.mirrorSource) this.mirrorLiveSource(record, latest, message);
    const newClone = this.buildClone(latest, message);
    const oldClone = card.querySelector(".gluniverse-stream-chat-message-clone");
    if (oldClone) oldClone.replaceWith(newClone);
    else card.prepend(newClone);
    applyThemeContext(card, latest);
    if (record.phase === "shown") {
      this.trackCardHeight(record);
      this.syncCardHeight(record);
    }
  }

  // Keep the card's height in sync with its content for the card's whole life.
  // Systems/modules (dnd5e, RSReforged) rewrite the chat card DOM asynchronously
  // after the initial render — via re-render hooks and a MutationObserver — and
  // dice icons/avatars load late, so the content grows after we first measure it.
  // A one-shot max-height snapshot would freeze the card at its early (tiny) size
  // and clip the bundled multiroll content. A ResizeObserver on the cloned content
  // re-measures whenever it changes and eases the card to the new height.
  trackCardHeight(record) {
    const card = record?.element;
    if (!card?.isConnected) return;
    const content = card.querySelector(".gluniverse-stream-chat-message-clone") ?? card;
    if (typeof ResizeObserver === "function") {
      record.resizeObserver?.disconnect();
      const observer = new ResizeObserver(() => window.requestAnimationFrame(() => this.syncCardHeight(record)));
      observer.observe(content);
      record.resizeObserver = observer;
      return;
    }
    // Without ResizeObserver, release the cap so late content is never clipped.
    if (record.phase === "shown") card.style.maxHeight = "none";
  }

  syncCardHeight(record) {
    const card = record?.element;
    if (!card?.isConnected || record.phase !== "shown") return;
    const height = card.scrollHeight;
    if (record.syncedHeight === height) return;
    record.syncedHeight = height;
    if (prefersCalmMotion()) {
      card.style.maxHeight = `${height}px`;
      return;
    }
    animate(card, { maxHeight: `${height}px`, duration: 320, ease: "outQuint" });
  }

  // Mirror the live chat card for the stream card's whole life. RSReforged (and
  // dnd5e itself) rewrite the rendered message DOM *after* the render hook — async
  // template injection, a MutationObserver-driven bonus manager, post-dice reveals —
  // without updating the ChatMessage document, so no update hook fires. A one-shot
  // clone can therefore capture an empty pre-processed husk and never recover.
  // Watching the live element and re-cloning on change keeps the stream card
  // pixel-identical to what a player sees in their chat log.
  mirrorLiveSource(record, source, message) {
    record.mirrorObserver?.disconnect();
    record.mirrorSource = source instanceof HTMLElement ? source : null;
    if (!record.mirrorSource || typeof MutationObserver !== "function") return;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        if (!record.element?.isConnected || record.phase === "exiting") return;
        this.refreshCardContents(record, message, record.mirrorSource);
      });
    });
    observer.observe(record.mirrorSource, { childList: true, subtree: true, attributes: true, characterData: true });
    record.mirrorObserver = observer;
  }

  buildClone(source, message) {
    const clone = source.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("gluniverse-stream-chat-message-clone");
    normalizeImages(clone, message);
    syncTimestamp(clone, message);
    stripOwnerControls(clone);
    return clone;
  }

  applySettings() {
    if (!this.streamMode.active) return;
    const root = this.streamMode.getChatRoot();
    const settings = getChatSettings();
    const position = settings.position;
    root.className = `${CLASSES.chatRoot} position-${position}`;
    root.style.setProperty("--stream-chat-offset-x", `${numberOrZero(settings.offsetX)}px`);
    root.style.setProperty("--stream-chat-offset-y", `${numberOrZero(settings.offsetY)}px`);
    // Roll cards are designed on a 1920px frame; scale them with the stream's actual width.
    root.style.setProperty("--glus-rc-scale", String((window.innerWidth || 1920) / 1920));
  }

  /** Collapse the card toward its corner while it fades and blurs out, then remove it. */
  removeCard(card) {
    const index = this.cards.findIndex(record => record.element === card);
    const record = index >= 0 ? this.cards[index] : null;
    if (record) {
      window.clearTimeout(record.timeout);
      record.resizeObserver?.disconnect();
      record.mirrorObserver?.disconnect();
      record.phase = "exiting";
      if (record.messageId && this.cardsByMessageId.get(record.messageId) === record) {
        this.cardsByMessageId.delete(record.messageId);
      }
      this.cards.splice(index, 1);
      if (record.rollCard) {
        this.feed.forget(record);
        record.rollCard.exit();
        return;
      }
    }
    if (!card?.isConnected) return;

    remove(card);
    const height = `${card.getBoundingClientRect().height}px`;
    const done = () => card.remove();
    if (prefersCalmMotion()) {
      animate(card, { opacity: 0, duration: 180, ease: "linear" });
      animate(card, { maxHeight: [height, "0px"], duration: 220, ease: "linear", onComplete: done });
      return;
    }
    const offsets = CARD_OFFSETS[getChatSettings().position] ?? CARD_OFFSETS["top-left"];
    animate(card, { maxHeight: [height, "0px"], duration: 380, ease: "inCubic" });
    animate(card, { opacity: 0, duration: 280, ease: "inCubic" });
    animate(card, { "--stream-chat-blur": "3px", "--stream-chat-shadow": 0.35, duration: 300, ease: "inQuad" });
    animate(card, {
      translateX: `${offsets.exitX}px`,
      translateY: `${offsets.exitY}px`,
      scale: 0.96,
      duration: 420,
      ease: "inQuart",
      onComplete: done
    });
  }

  clear() {
    for (const record of this.cards) {
      window.clearTimeout(record.timeout);
      record.resizeObserver?.disconnect();
      record.mirrorObserver?.disconnect();
      if (record.rollCard) {
        this.feed.forget(record);
        record.rollCard.destroy();
      }
    }
    this.cards = [];
    this.cardsByMessageId.clear();
    this.feed.clear();
    document.querySelectorAll(".gluniverse-stream-chat-card").forEach(card => {
      remove(card);
      remove(card.querySelector(".gluniverse-stream-chat-sheen"));
      card.remove();
    });
  }
}

// Theme context (Foundry core themes + module themes such as PF2e Dorako UI) is
// provided to chat messages by ancestor elements, not the message itself: core
// defines its CSS variables on a `.themed.theme-dark`/`.theme-light` ancestor and
// modules scope their chat styling under a `[data-theme]` ancestor. Because the
// stream card lives outside `#chat-log`, the cloned message loses that context and
// renders unstyled. Re-apply the relevant markers from the live message's ancestry
// onto the card so the clone resolves the same variables and matches scoped rules.
const THEME_CLASS_PATTERN = /^(themed|theme-[\w-]+|dorako-ui|color-?scheme-[\w-]+)$/i;
const THEME_CONTEXT_ATTRIBUTES = ["data-theme", "data-color-scheme"];

// Foundry core and game systems (notably dnd5e) scope their chat card styling to a
// container ancestor rather than the message element itself — e.g. dnd5e matches
// `:is(.chat-popout, #chat-log, .chat-log) .message`. The cloned message lives
// outside `#chat-log`, so without that ancestor the card renders unstyled. Marking
// the wrapper as `.chat-popout` (the same context core uses for a popped-out
// message) restores those rules. Crucially we do NOT add the `[data-gm-user]`
// marker that the live sidebar carries for a GM, so dnd5e keeps concealed/secret
// card details hidden — matching exactly what a normal player sees on stream.
const CHAT_CONTEXT_CLASS = "chat-popout";

// Transient renders (RSReforged previews/processing husks, locally constructed
// ChatMessage objects) go through renderChatMessageHTML but are never part of the
// world's chat history — they have no id in game.messages, timestamp 0 and empty
// content. Only persisted messages become stream cards.
function isPersistedMessage(message, source) {
  const id = message?.id ?? source?.dataset?.messageId;
  return Boolean(id && game.messages?.get?.(id));
}

// A message that a regular player would never see (GM-only whispers, blind rolls)
// must not leak onto the stream just because the streamer is logged in as a GM.
function isAudienceVisible(message) {
  if (!message) return false;
  if (message.blind) return false;
  const whisper = Array.isArray(message.whisper) ? message.whisper : [];
  if (whisper.length === 0) return true;
  return whisper.some(id => {
    const user = game.users?.get?.(id);
    return user ? !user.isGM : false;
  });
}

// Interactive roll-editing affordances — e.g. RSReforged's hover overlays for retro
// advantage/disadvantage/crit and GM dice fudging — are owner/GM-only controls that a
// passive spectator never sees. They carry no roll result, can't be used on a
// pointer-inert stream card, and would otherwise leak onto the stream whenever the
// streamer owns the roll or is logged in as a GM. Drop them so the card matches a
// normal player's view of someone else's roll.
const OWNER_CONTROL_SELECTORS = [".rsr-overlay"];

function stripOwnerControls(clone) {
  for (const selector of OWNER_CONTROL_SELECTORS) {
    clone.querySelectorAll(selector).forEach(element => element.remove());
  }
}

// The clone captures the relative timestamp text frozen at render time, and Foundry
// only refreshes timestamps inside `#chat-log`. Re-derive the text from the message's
// own timestamp so the stream card shows the same time as the live chat message.
function syncTimestamp(clone, message) {
  const timestamp = Number(message?.timestamp);
  // Guard against unset/zero timestamps (transient renders) which would otherwise
  // display as a relative time measured from the 1970 epoch.
  if (!Number.isFinite(timestamp) || timestamp <= 0) return;
  const timeSince = foundry?.utils?.timeSince;
  if (typeof timeSince !== "function") return;
  const element = clone.querySelector("time.message-timestamp, .message-timestamp, time");
  if (!element) return;
  element.textContent = timeSince(timestamp);
  element.setAttribute("datetime", new Date(timestamp).toISOString());
}

function applyThemeContext(card, source) {
  for (const cls of [...card.classList]) {
    if (THEME_CLASS_PATTERN.test(cls)) card.classList.remove(cls);
  }
  for (const attr of THEME_CONTEXT_ATTRIBUTES) card.removeAttribute(attr);
  if (!(source instanceof HTMLElement)) return;

  const themed = source.closest(".themed");
  if (themed) {
    for (const cls of themed.classList) {
      if (THEME_CLASS_PATTERN.test(cls)) card.classList.add(cls);
    }
  }
  for (const attr of THEME_CONTEXT_ATTRIBUTES) {
    const owner = source.closest(`[${attr}]`);
    if (owner) card.setAttribute(attr, owner.getAttribute(attr));
  }
}

function normalizeImages(element, message) {
  const speakerImage = getSpeakerImage(message);
  element.querySelectorAll("img").forEach(img => {
    const dataSrc = getImageSource(img);
    if ((!img.getAttribute("src") || img.getAttribute("src") === "") && dataSrc) img.setAttribute("src", dataSrc);
    img.removeAttribute("loading");
  });
  ensureSpeakerImage(element, speakerImage);
}

function ensureSpeakerImage(element, imageUrl) {
  if (!imageUrl) return;
  const header = element.querySelector(".message-header") ?? element.querySelector("header");
  if (!header) return;
  const image = header.querySelector("img.avatar, img.message-avatar, img.gluniverse-stream-speaker-avatar, img");
  if (image) {
    if (!image.getAttribute("src")) image.setAttribute("src", imageUrl);
    return;
  }
  const avatar = document.createElement("img");
  avatar.className = "avatar gluniverse-stream-speaker-avatar";
  avatar.src = imageUrl;
  avatar.alt = "";
  header.prepend(avatar);
}

function getImageSource(img) {
  for (const attr of ["data-src", "data-original", "data-lazy-src", "data-tooltip-src", "src"]) {
    const value = img.getAttribute(attr);
    if (value) return value;
  }
  return img.dataset.src ?? img.dataset.original ?? img.dataset.lazySrc ?? null;
}

function getSpeakerImage(message) {
  const speaker = message?.speaker ?? {};
  const tokenDocument = getSpeakerTokenDocument(speaker);
  const actor = tokenDocument?.actor ?? message?.actor ?? message?.speakerActor ?? game.actors?.get?.(speaker.actor);
  return tokenDocument?.texture?.src ?? tokenDocument?.img ?? actor?.img ?? null;
}

function getSpeakerTokenDocument(speaker) {
  if (!speaker?.token) return null;
  const scene = game.scenes?.get?.(speaker.scene) ?? canvas?.scene;
  return scene?.tokens?.get?.(speaker.token)
    ?? canvas?.tokens?.placeables?.find(token => token.document?.id === speaker.token)?.document
    ?? null;
}

/** PF2e worlds get the purpose-built roll card; every other system keeps the cloned chat card. */
function usesRollCards() {
  return game.system?.id === "pf2e";
}

function getLatestRenderedMessage(source, message, messageId) {
  const id = message?.id ?? messageId;
  const uuid = message?.uuid;
  const selectors = [];
  if (id) selectors.push(`#chat-log [data-message-id="${cssEscape(id)}"]`, `#chat [data-message-id="${cssEscape(id)}"]`);
  if (uuid) selectors.push(`#chat-log [data-message-uuid="${cssEscape(uuid)}"]`, `#chat [data-message-uuid="${cssEscape(uuid)}"]`);
  for (const selector of selectors) {
    const element = document.querySelector(selector);
    if (element) return element;
  }
  return source?.isConnected && !source.closest(".gluniverse-stream-chat-card") ? source : null;
}

function cssEscape(value) {
  return globalThis.CSS?.escape ? globalThis.CSS.escape(String(value)) : String(value).replace(/["\\]/g, "\\$&");
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function nextFrame() {
  return new Promise(resolve => window.requestAnimationFrame(() => resolve()));
}

function getElement(html) {
  if (html instanceof HTMLElement) return html;
  if (html?.[0] instanceof HTMLElement) return html[0];
  if (html?.element instanceof HTMLElement) return html.element;
  return null;
}
