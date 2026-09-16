import { MAX_CONTROL_TEXT_BYTES } from "./protocol.js";

export interface ChatSurfaceAdapter {
  isSupported(): Promise<boolean>;
  sendControlText(text: string): Promise<void>;
  observeAssistantControls(onControl: (text: string) => void): () => void;
  conversationIdentity(): Promise<string | null>;
}

export interface ChatGptSurfaceDependencies {
  document: Document;
  location: Location;
  createObserver?: (callback: MutationCallback) => { observe(target: Node, options?: MutationObserverInit): void; disconnect(): void };
}

const COMPOSER_SELECTORS = [
  "#prompt-textarea[contenteditable='true']",
  "textarea#prompt-textarea",
  "textarea[data-testid='prompt-textarea']",
] as const;
const SEND_SELECTORS = [
  "button[data-testid='send-button']",
  "button[aria-label='Send prompt']",
  "button[aria-label='Send message']",
] as const;
const MESSAGE_SELECTOR = "[data-message-author-role]";
const MAX_MESSAGE_SCAN = 200;

function uniqueMatches<T extends Element>(document: Document, selectors: readonly string[]): T[] {
  const matches = new Set<T>();
  for (const selector of selectors) {
    for (const element of document.querySelectorAll<T>(selector)) matches.add(element);
  }
  return [...matches];
}

function isSendButton(element: Element): element is HTMLButtonElement {
  return element instanceof HTMLButtonElement;
}

function controlTextFromAssistant(element: Element): string | null {
  if (element.getAttribute("data-message-author-role") !== "assistant") return null;
  const text = element.textContent ?? "";
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstNewline = normalized.indexOf("\n");
  const firstLine = firstNewline === -1 ? normalized : normalized.slice(0, firstNewline);
  return firstLine === "[CHAT2CODEX]" ? normalized : null;
}

function dispatchInputEvents(element: HTMLElement): void {
  element.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

export class ChatGptSurfaceAdapter implements ChatSurfaceAdapter {
  constructor(private readonly dependencies: ChatGptSurfaceDependencies) {}

  async isSupported(): Promise<boolean> {
    return this.resolveSurface() !== null;
  }

  async sendControlText(text: string): Promise<void> {
    if (new TextEncoder().encode(text).byteLength > MAX_CONTROL_TEXT_BYTES) throw new Error("RELAY_CONTROL_TEXT_TOO_LARGE");
    const surface = this.resolveSurface();
    if (!surface) throw new Error("RELAY_UI_UNSUPPORTED");

    const { composer, send } = surface;
    if (composer instanceof HTMLTextAreaElement) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
    } else if (composer instanceof HTMLElement && composer.isContentEditable) {
      composer.textContent = text;
    } else {
      throw new Error("RELAY_UI_UNSUPPORTED");
    }
    dispatchInputEvents(composer as HTMLElement);
    await Promise.resolve();
    send.click();
  }

  observeAssistantControls(onControl: (text: string) => void): () => void {
    const seen = new Set<Element>();
    const scan = () => {
      const messages = [...this.dependencies.document.querySelectorAll(MESSAGE_SELECTOR)].slice(-MAX_MESSAGE_SCAN);
      for (const message of messages) {
        if (seen.has(message)) continue;
        seen.add(message);
        const control = controlTextFromAssistant(message);
        if (control !== null) onControl(control);
      }
    };
    scan();
    const observer = this.dependencies.createObserver
      ? this.dependencies.createObserver(() => scan())
      : new MutationObserver(() => scan());
    observer.observe(this.dependencies.document.documentElement, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }

  async conversationIdentity(): Promise<string | null> {
    const match = this.dependencies.location.pathname.match(/^\/c\/([^/?#]+)(?:\/|$)/);
    return match?.[1] ?? null;
  }

  private resolveSurface(): { composer: Element; send: HTMLButtonElement } | null {
    const composers = uniqueMatches(this.dependencies.document, COMPOSER_SELECTORS);
    const sends = uniqueMatches(this.dependencies.document, SEND_SELECTORS).filter(isSendButton);
    if (composers.length !== 1 || sends.length !== 1) return null;
    const composer = composers[0]!;
    const validComposer = composer instanceof HTMLTextAreaElement || (composer instanceof HTMLElement && composer.isContentEditable);
    return validComposer ? { composer, send: sends[0]! } : null;
  }
}
