import { describe, expect, it } from "vitest";
import { ChatGptSurfaceAdapter } from "../../extension/src/chat-surface.js";

describe("ChatGptSurfaceAdapter", () => {
  it("extracts conversation identity from /c/<id> URLs", async () => {
    const adapter = new ChatGptSurfaceAdapter({
      document: {} as Document,
      location: new URL("https://chatgpt.com/c/abc-123?x=1") as unknown as Location,
    });
    await expect(adapter.conversationIdentity()).resolves.toBe("abc-123");
  });

  it("returns null outside a conversation URL", async () => {
    const adapter = new ChatGptSurfaceAdapter({
      document: {} as Document,
      location: new URL("https://chatgpt.com/") as unknown as Location,
    });
    await expect(adapter.conversationIdentity()).resolves.toBeNull();
  });
});
