import { CLASSES, MODULE_ID } from "./constants.js";
import { getChatSettings } from "./settings.js";

export class ChatOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.cards = [];
    this.cardsByMessageId = new Map();
  }

  registerHooks() {
    Hooks.on("renderChatMessageHTML", (message, html) => this.handleRenderedMessage(message, html));
    Hooks.on("updateChatMessage", message => this.handleMessageUpdate(message));
    Hooks.on("deleteChatMessage", message => this.handleMessageDelete(message));
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (key === "chatSettings") this.applySettings();
    });
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => {
      if (active) this.applySettings();
      else this.clear();
    });
  }

  handleRenderedMessage(message, html) {
    if (!this.streamMode.active) return;
    if (!isAudienceVisible(message)) return;
    const source = getElement(html);
    if (!source) return;
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
    if (!this.streamMode.active) return;
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
    card.className = `gluniverse-stream-chat-card gluniverse-stream-entering ${CHAT_CONTEXT_CLASS}`;
    if (messageId) card.dataset.streamMessageId = messageId;
    card.append(this.buildClone(latest, message));
    applyThemeContext(card, latest);
    root.append(card);
    card.style.maxHeight = "0px";

    const record = {
      element: card,
      messageId,
      timeout: window.setTimeout(() => this.removeCard(card), Math.max(0, Number(settings.lifetimeMs) || 0))
    };
    this.cards.push(record);
    if (messageId) this.cardsByMessageId.set(messageId, record);

    window.requestAnimationFrame(() => {
      card.classList.remove("gluniverse-stream-entering");
      card.style.maxHeight = `${card.scrollHeight}px`;
      this.trackCardHeight(record);
    });
    while (this.cards.length > Math.max(1, Number(settings.maxVisible) || 5)) {
      this.removeCard(this.cards[0].element, true);
    }
  }

  refreshCardContents(record, message, source) {
    const card = record?.element;
    if (!card?.isConnected) return;
    const latest = getLatestRenderedMessage(source, message, record.messageId) ?? source;
    if (!latest) return;
    const newClone = this.buildClone(latest, message);
    const oldClone = card.querySelector(".gluniverse-stream-chat-message-clone");
    if (oldClone) oldClone.replaceWith(newClone);
    else card.append(newClone);
    applyThemeContext(card, latest);
    if (!card.classList.contains("gluniverse-stream-entering") && !card.classList.contains("gluniverse-stream-exiting")) {
      this.trackCardHeight(record);
      card.style.maxHeight = `${card.scrollHeight}px`;
    }
  }

  // Keep the card's height in sync with its content for the card's whole life.
  // Systems/modules (dnd5e, RSReforged) rewrite the chat card DOM asynchronously
  // after the initial render — via re-render hooks and a MutationObserver — and
  // dice icons/avatars load late, so the content grows after we first measure it.
  // A one-shot max-height snapshot would freeze the card at its early (tiny) size
  // and clip the bundled multiroll content. A ResizeObserver on the cloned content
  // re-measures and re-targets max-height whenever it changes, so the card always
  // grows to fit. (Exit collapses via the .gluniverse-stream-exiting !important rule.)
  trackCardHeight(record) {
    const card = record?.element;
    if (!card?.isConnected) return;
    const content = card.querySelector(".gluniverse-stream-chat-message-clone") ?? card;
    const sync = () => {
      if (!card.isConnected) return;
      if (card.classList.contains("gluniverse-stream-entering")) return;
      if (card.classList.contains("gluniverse-stream-exiting")) return;
      card.style.maxHeight = `${card.scrollHeight}px`;
    };
    if (typeof ResizeObserver === "function") {
      record.resizeObserver?.disconnect();
      const observer = new ResizeObserver(() => window.requestAnimationFrame(sync));
      observer.observe(content);
      record.resizeObserver = observer;
      return;
    }
    // Without ResizeObserver, release the cap once the enter settles so late content
    // is never clipped.
    window.setTimeout(() => {
      if (card.isConnected && !card.classList.contains("gluniverse-stream-exiting")) card.style.maxHeight = "none";
    }, 700);
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
  }

  removeCard(card, immediate = false) {
    const index = this.cards.findIndex(record => record.element === card);
    if (index >= 0) {
      const record = this.cards[index];
      window.clearTimeout(record.timeout);
      record.resizeObserver?.disconnect();
      if (record.messageId && this.cardsByMessageId.get(record.messageId) === record) {
        this.cardsByMessageId.delete(record.messageId);
      }
      this.cards.splice(index, 1);
    }
    if (!card?.isConnected) return;
    if (immediate) {
      card.remove();
      return;
    }
    card.style.maxHeight = `${card.scrollHeight}px`;
    card.getBoundingClientRect();
    card.classList.add("gluniverse-stream-exiting");
    window.setTimeout(() => card.remove(), 460);
  }

  clear() {
    for (const record of this.cards) {
      window.clearTimeout(record.timeout);
      record.resizeObserver?.disconnect();
    }
    this.cards = [];
    this.cardsByMessageId.clear();
    document.querySelectorAll(".gluniverse-stream-chat-card").forEach(card => card.remove());
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
  if (!Number.isFinite(timestamp)) return;
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

async function waitForDiceAnimation(message) {
  const hasRoll = Boolean(message?.rolls?.length) || Boolean(message?.isRoll);
  if (!hasRoll) return delay(120);
  const messageId = message?.id;
  const dice3d = game?.dice3d;
  try {
    if (messageId && typeof dice3d?.waitFor3DAnimationByMessageID === "function") {
      await Promise.race([dice3d.waitFor3DAnimationByMessageID(messageId), delay(10000)]);
      return;
    }
  } catch (error) {
    console.warn(`${MODULE_ID} | Dice animation wait failed`, error);
  }
  if (messageId && game.modules?.get("dice-so-nice")?.active) {
    await waitForDiceSoNiceHook(messageId, 5000);
    return;
  }
  return delay(300);
}

function waitForDiceSoNiceHook(messageId, timeoutMs) {
  return new Promise(resolve => {
    let timeout;
    const done = () => {
      window.clearTimeout(timeout);
      Hooks.off("diceSoNiceRollComplete", hookId);
      resolve();
    };
    const hookId = Hooks.on("diceSoNiceRollComplete", completed => {
      const completedId = typeof completed === "string" ? completed : completed?.id ?? completed?.messageId;
      if (completedId !== messageId) return;
      done();
    });
    timeout = window.setTimeout(done, timeoutMs);
  });
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

function delay(ms) {
  return new Promise(resolve => window.setTimeout(resolve, ms));
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
