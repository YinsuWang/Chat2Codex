import { afterEach, describe, expect, it, vi } from "vitest";

import { initializeContentScript } from "../../extension/src/content-script.js";

const STATE_KEY = "chat2codex_relay_state";
const WORKSPACE = "ws_0123456789abcdef";

class FakeDocument {
  documentElement = {} as HTMLElement;

  querySelectorAll<T extends Element>(): NodeListOf<T> {
    return [] as unknown as NodeListOf<T>;
  }
}

class FakeMutationObserver {
  observe(): void {}
  disconnect(): void {}
}

function apiFor(conversationId: string) {
  const sent: unknown[] = [];
  const api = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({
          [key]: {
            workspace_id: WORKSPACE,
            conversation_id: conversationId,
          },
        })),
      },
    },
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        sent.push(message);
        return undefined;
      }),
      onMessage: {
        addListener: vi.fn(),
      },
    },
  };
  return { api, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("content script binding heartbeat", () => {
  it("does not announce a different conversation during initialization", async () => {
    vi.stubGlobal("MutationObserver", FakeMutationObserver);
    const { api, sent } = apiFor("bound-conversation");

    const stop = initializeContentScript(
      api,
      new FakeDocument() as unknown as Document,
      new URL("https://chatgpt.com/c/other-conversation") as unknown as Location,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sent).toEqual([]);
    stop();
    expect(api.storage.local.get).toHaveBeenCalledWith(STATE_KEY);
  });
});
