import { CLASSES, MODULE_ID } from "./constants.js";
import { getChatSettings } from "./settings.js";

export class ChatOverlay {
  constructor(streamMode) {
    this.streamMode = streamMode;
    this.cards = [];
    this.seenMessageIds = new Set();
  }

  registerHooks() {
    Hooks.on("renderChatMessageHTML", (message, html) => this.addRenderedMessage(message, html));
    Hooks.on(`${MODULE_ID}.settingsChanged`, key => {
      if (key === "chatSettings") this.applySettings();
    });
    Hooks.on(`${MODULE_ID}.streamModeChanged`, active => {
      if (active) this.applySettings();
      else this.clear();
    });
  }

  addRenderedMessage(message, html) {
    if (!this.streamMode.active) return;
    const source = getElement(html);
    if (!source) return;
    const messageId = message?.id ?? message?.uuid ?? source.dataset.messageId ?? source.dataset.messageUuid;
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return;
      this.seenMessageIds.add(messageId);
    }

    this.addRenderedMessageAfterDice(message, source, messageId);
  }

  async addRenderedMessageAfterDice(message, source, messageId) {
    await waitForDiceAnimation(message);
    await nextFrame();
    if (!this.streamMode.active) return;

    source = getLatestRenderedMessage(source, message, messageId);
    if (!source) return;

    const settings = getChatSettings();
    const root = this.streamMode.getChatRoot();
    this.applySettings();

    const card = document.createElement("div");
    card.className = "gluniverse-stream-chat-card gluniverse-stream-entering";
    const clone = source.cloneNode(true);
    clone.removeAttribute("id");
    clone.classList.add("gluniverse-stream-chat-message-clone");
    normalizeImages(clone, message);
    card.append(clone);
    root.append(card);
    card.style.maxHeight = "0px";

    const record = {
      element: card,
      timeout: window.setTimeout(() => this.removeCard(card), Math.max(0, Number(settings.lifetimeMs) || 0))
    };
    this.cards.push(record);

    window.requestAnimationFrame(() => {
      card.style.maxHeight = `${card.scrollHeight}px`;
      card.classList.remove("gluniverse-stream-entering");
    });
    card.addEventListener("transitionend", event => {
      if (event.propertyName === "max-height" && !card.classList.contains("gluniverse-stream-exiting")) card.style.maxHeight = "none";
    }, { once: true });
    while (this.cards.length > Math.max(1, Number(settings.maxVisible) || 5)) {
      this.removeCard(this.cards[0].element, true);
    }
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
      window.clearTimeout(this.cards[index].timeout);
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
    window.setTimeout(() => card.remove(), 420);
  }

  clear() {
    for (const record of this.cards) window.clearTimeout(record.timeout);
    this.cards = [];
    this.seenMessageIds.clear();
    document.querySelectorAll(".gluniverse-stream-chat-card").forEach(card => card.remove());
  }
}

function normalizeImages(element, message) {
  const speakerImage = getSpeakerImage(message);
  element.querySelectorAll("img").forEach(img => {
    const dataSrc = getImageSource(img);
    if ((!img.getAttribute("src") || img.getAttribute("src") === "") && dataSrc) img.setAttribute("src", dataSrc);
    img.removeAttribute("loading");
    img.style.display = "block";
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
    image.style.display = "block";
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
