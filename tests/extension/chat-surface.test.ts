import { beforeEach, describe, expect, it } from "vitest";
import { ChatGptSurfaceAdapter } from "../../extension/src/chat-surface.js";
class FakeHTMLElement {
  textContent = ""; isContentEditable = false; readonly events: string[] = []; readonly attributes = new Map<string, string>();
  dispatchEvent(event: Event): boolean { this.events.push(event.type); return true; }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
}
class FakeTextArea extends FakeHTMLElement { value = ""; }
class FakeButton extends FakeHTMLElement { clicks = 0; click(): void { this.clicks += 1; } }
class FakeDocument {
  documentElement = {} as HTMLElement;
  constructor(readonly composers: FakeHTMLElement[], readonly sends: FakeButton[], readonly messages: FakeHTMLElement[] = []) {}
  querySelectorAll<T extends Element>(selector: string): NodeListOf<T> {
    let values: FakeHTMLElement[] = [];
    if (selector.includes("prompt-textarea")) values = this.composers;
    else if (selector.includes("send-button") || selector.includes("Send prompt") || selector.includes("Send message")) values = this.sends;
    else if (selector === "[data-message-author-role]") values = this.messages;
    return values as unknown as NodeListOf<T>;
  }
}
type ObserverFactory = NonNullable<ConstructorParameters<typeof ChatGptSurfaceAdapter>[0]["createObserver"]>;
beforeEach(() => {
  Object.defineProperty(globalThis, "HTMLElement", { configurable: true, value: FakeHTMLElement });
  Object.defineProperty(globalThis, "HTMLTextAreaElement", { configurable: true, value: FakeTextArea });
  Object.defineProperty(globalThis, "HTMLButtonElement", { configurable: true, value: FakeButton });
  Object.defineProperty(globalThis, "Event", { configurable: true, value: class { constructor(readonly type: string) {} } });
});
function contentEditable(): FakeHTMLElement { const element = new FakeHTMLElement(); element.isContentEditable = true; return element; }
function adapterFor(document: FakeDocument, createObserver?: ObserverFactory): ChatGptSurfaceAdapter {
  return new ChatGptSurfaceAdapter({ document: document as unknown as Document, location: new URL("https://chatgpt.com/c/abc-123") as unknown as Location, ...(createObserver ? { createObserver } : {}) });
}
describe("ChatGptSurfaceAdapter", () => {
  it("is supported only with one unambiguous composer and send control", async () => {
    await expect(adapterFor(new FakeDocument([contentEditable()], [new FakeButton()])).isSupported()).resolves.toBe(true);
    await expect(adapterFor(new FakeDocument([], [new FakeButton()])).isSupported()).resolves.toBe(false);
    await expect(adapterFor(new FakeDocument([contentEditable(), contentEditable()], [new FakeButton()])).isSupported()).resolves.toBe(false);
    await expect(adapterFor(new FakeDocument([contentEditable()], [new FakeButton(), new FakeButton()])).isSupported()).resolves.toBe(false);
  });
  it("fails closed instead of sending through an ambiguous surface", async () => {
    await expect(adapterFor(new FakeDocument([contentEditable(), contentEditable()], [new FakeButton()])).sendControlText("[CHAT2CODEX]\nhello")).rejects.toThrow("RELAY_UI_UNSUPPORTED");
  });
  it("assigns exact text, emits input/change, and submits once without innerHTML", async () => {
    const composer = contentEditable(); const send = new FakeButton(); const text = "[CHAT2CODEX]\nline 2\nline 3";
    await adapterFor(new FakeDocument([composer], [send])).sendControlText(text);
    expect(composer.textContent).toBe(text); expect(composer.events).toEqual(["input", "change"]); expect(send.clicks).toBe(1);
    expect(Object.prototype.hasOwnProperty.call(composer, "innerHTML")).toBe(false);
  });
  it("rejects control text over 16 KiB before DOM work", async () => {
    const send = new FakeButton();
    await expect(adapterFor(new FakeDocument([contentEditable()], [send])).sendControlText("x".repeat(16 * 1024 + 1))).rejects.toThrow("RELAY_CONTROL_TEXT_TOO_LARGE");
    expect(send.clicks).toBe(0);
  });
  it("observes only exact first-line assistant controls, preserves text, and deduplicates rescans", () => {
    const user = new FakeHTMLElement(); user.setAttribute("data-message-author-role", "user"); user.textContent = "[CHAT2CODEX]\r\nuser";
    const prose = new FakeHTMLElement(); prose.setAttribute("data-message-author-role", "assistant"); prose.textContent = "prose [CHAT2CODEX]\nlater";
    const control = new FakeHTMLElement(); control.setAttribute("data-message-author-role", "assistant"); control.textContent = "[CHAT2CODEX]\r\nreview";
    const emitted: string[] = []; let rescan: MutationCallback | undefined; let disconnected = false;
    const stop = adapterFor(new FakeDocument([], [], [user, prose, control]), (callback) => { rescan = callback; return { observe() {}, disconnect() { disconnected = true; } }; })
      .observeAssistantControls((text) => emitted.push(text));
    rescan?.([] as unknown as MutationRecord[], {} as MutationObserver);
    expect(emitted).toEqual(["[CHAT2CODEX]\r\nreview"]); stop(); expect(disconnected).toBe(true);
  });
  it("extracts conversation identity from /c/<id> URLs", async () => {
    const adapter = new ChatGptSurfaceAdapter({ document: {} as Document, location: new URL("https://chatgpt.com/c/abc-123?x=1") as unknown as Location });
    await expect(adapter.conversationIdentity()).resolves.toBe("abc-123");
  });
  it("returns null outside a conversation URL", async () => {
    const adapter = new ChatGptSurfaceAdapter({ document: {} as Document, location: new URL("https://chatgpt.com/") as unknown as Location });
    await expect(adapter.conversationIdentity()).resolves.toBeNull();
  });
});
