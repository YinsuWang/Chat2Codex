import { describe, expect, it, vi } from "vitest";

import {
  PopupController,
  derivePopupState,
  type PopupControllerDependencies,
  type PopupRelayState,
} from "../../extension/src/popup.js";

const UNBOUND_STATE: PopupRelayState = {
  workspace_id: "ws_0123456789abcdef",
  workspace_name: "Fixture",
  relay_port: 48765,
  extension_id: "ext-test",
  bound_tab_id: null,
  conversation_id: null,
};

const BOUND_STATE: PopupRelayState = {
  ...UNBOUND_STATE,
  bound_tab_id: 42,
  conversation_id: "conversation-1",
};

function fixture(initial: PopupRelayState | null = null) {
  let state = initial;
  const deps: PopupControllerDependencies = {
    getState: vi.fn(async () => state),
    pair: vi.fn(async ({ workspace_id }) => ({ workspace_id, token: "raw-long-lived-token" })),
    savePairing: vi.fn(async ({ workspace_id, relay_port, extension_id }) => {
      state = {
        workspace_id,
        workspace_name: workspace_id,
        relay_port,
        extension_id,
        bound_tab_id: null,
        conversation_id: null,
      };
    }),
    queryActiveTab: vi.fn(async () => ({ id: 42, url: "https://chatgpt.com/c/conversation-1" })),
    conversationIdentity: vi.fn(async () => "conversation-1"),
    bind: vi.fn(async (tabId, conversationId) => {
      if (!state) throw new Error("UNPAIRED");
      state = { ...state, bound_tab_id: tabId, conversation_id: conversationId };
    }),
    unbind: vi.fn(async () => {
      if (!state) throw new Error("UNPAIRED");
      state = { ...state, bound_tab_id: null, conversation_id: null };
    }),
    unpair: vi.fn(async () => { state = null; }),
    createExtensionId: vi.fn(() => "generated-extension-identity"),
  };
  return { controller: new PopupController(deps), deps, getState: () => state };
}

describe("extension pairing popup", () => {
  it("derives the four explicit popup states", () => {
    expect(derivePopupState(null, null)).toBe("UNPAIRED");
    expect(derivePopupState(UNBOUND_STATE, null)).toBe("PAIRED_NO_TAB");
    expect(derivePopupState(BOUND_STATE, null)).toBe("PAIRED_BOUND");
    expect(derivePopupState(BOUND_STATE, "boom")).toBe("ERROR");
  });

  it("pairs through loopback and never exposes the raw relay token in popup state", async () => {
    const { controller, deps } = fixture();
    const view = await controller.pair({
      relay_port: 48765,
      workspace_id: "ws_0123456789abcdef",
      code: "ABCDEFGH",
    });

    expect(deps.pair).toHaveBeenCalledWith({
      relay_port: 48765,
      workspace_id: "ws_0123456789abcdef",
      code: "ABCDEFGH",
      extension_id: "generated-extension-identity",
    });
    expect(deps.savePairing).toHaveBeenCalledWith({
      relay_port: 48765,
      workspace_id: "ws_0123456789abcdef",
      relay_token: "raw-long-lived-token",
      extension_id: "generated-extension-identity",
    });
    expect(view.state).toBe("PAIRED_NO_TAB");
    expect(JSON.stringify(view)).not.toContain("raw-long-lived-token");
  });

  it("refuses to bind a non-chatgpt.com active tab", async () => {
    const { controller, deps } = fixture(UNBOUND_STATE);
    vi.mocked(deps.queryActiveTab).mockResolvedValue({ id: 7, url: "https://example.com/" });

    await expect(controller.bindCurrentTab()).rejects.toThrow("RELAY_BIND_UNSUPPORTED_TAB");
    expect(deps.conversationIdentity).not.toHaveBeenCalled();
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("binds only after an explicit action and saves the content-script conversation identity", async () => {
    const { controller, deps } = fixture(UNBOUND_STATE);
    expect(deps.bind).not.toHaveBeenCalled();

    const view = await controller.bindCurrentTab();

    expect(deps.queryActiveTab).toHaveBeenCalledTimes(1);
    expect(deps.conversationIdentity).toHaveBeenCalledWith(42);
    expect(deps.bind).toHaveBeenCalledWith(42, "conversation-1");
    expect(view.state).toBe("PAIRED_BOUND");
  });

  it("fails closed when the current ChatGPT tab has no conversation identity", async () => {
    const { controller, deps } = fixture(UNBOUND_STATE);
    vi.mocked(deps.conversationIdentity).mockResolvedValue(null);

    await expect(controller.bindCurrentTab()).rejects.toThrow("RELAY_CONVERSATION_UNAVAILABLE");
    expect(deps.bind).not.toHaveBeenCalled();
  });

  it("unbinds without removing pairing authorization", async () => {
    const { controller, deps, getState } = fixture(BOUND_STATE);
    const view = await controller.unbind();

    expect(deps.unbind).toHaveBeenCalledTimes(1);
    expect(deps.unpair).not.toHaveBeenCalled();
    expect(getState()).toMatchObject({ workspace_id: UNBOUND_STATE.workspace_id, bound_tab_id: null, conversation_id: null });
    expect(view.state).toBe("PAIRED_NO_TAB");
  });

  it("unpairs through the service worker without returning the token to popup code", async () => {
    const { controller, deps } = fixture(BOUND_STATE);
    const view = await controller.unpair();

    expect(deps.unpair).toHaveBeenCalledWith();
    expect(view.state).toBe("UNPAIRED");
    expect(JSON.stringify(view)).not.toContain("token");
  });
});
