const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;
const PAIRING_CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

export type PopupState = "UNPAIRED" | "PAIRED_NO_TAB" | "PAIRED_BOUND" | "ERROR";

export interface PopupRelayState {
  workspace_id: string;
  workspace_name: string;
  relay_port: number;
  extension_id: string;
  bound_tab_id: number | null;
  conversation_id: string | null;
}

export interface PopupView {
  state: PopupState;
  relay: PopupRelayState | null;
  error: string | null;
}

export interface PairInput {
  relay_port: number;
  workspace_id: string;
  code: string;
}

export interface PopupControllerDependencies {
  getState(): Promise<PopupRelayState | null>;
  pair(input: PairInput & { extension_id: string }): Promise<{ workspace_id: string; token: string }>;
  savePairing(input: {
    relay_port: number;
    workspace_id: string;
    relay_token: string;
    extension_id: string;
  }): Promise<void>;
  queryActiveTab(): Promise<{ id: number | null; url: string | null }>;
  conversationIdentity(tabId: number): Promise<string | null>;
  bind(tabId: number, conversationId: string): Promise<void>;
  unbind(): Promise<void>;
  unpair(): Promise<void>;
  createExtensionId(): string;
}

export function derivePopupState(state: PopupRelayState | null, error: string | null): PopupState {
  if (error) return "ERROR";
  if (!state) return "UNPAIRED";
  if (state.bound_tab_id === null || state.conversation_id === null) return "PAIRED_NO_TAB";
  return "PAIRED_BOUND";
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : "RELAY_POPUP_ERROR";
}

export class PopupController {
  constructor(private readonly deps: PopupControllerDependencies) {}

  async view(error: string | null = null): Promise<PopupView> {
    const state = await this.deps.getState();
    return { state: derivePopupState(state, error), relay: state, error };
  }

  async pair(input: PairInput): Promise<PopupView> {
    if (!validPort(input.relay_port)) throw new Error("RELAY_PORT_INVALID");
    if (!WORKSPACE_ID_PATTERN.test(input.workspace_id)) throw new Error("RELAY_WORKSPACE_INVALID");
    if (!PAIRING_CODE_PATTERN.test(input.code)) throw new Error("RELAY_PAIRING_CODE_INVALID");

    const extensionId = this.deps.createExtensionId();
    if (extensionId.length < 1 || extensionId.length > 256) throw new Error("RELAY_EXTENSION_ID_INVALID");
    const issued = await this.deps.pair({ ...input, extension_id: extensionId });
    if (issued.workspace_id !== input.workspace_id || issued.token.length < 1 || issued.token.length > 256) {
      throw new Error("RELAY_PAIRING_RESPONSE_INVALID");
    }
    await this.deps.savePairing({
      relay_port: input.relay_port,
      workspace_id: input.workspace_id,
      relay_token: issued.token,
      extension_id: extensionId,
    });
    return this.view();
  }

  async bindCurrentTab(): Promise<PopupView> {
    const current = await this.deps.getState();
    if (!current) throw new Error("RELAY_NOT_PAIRED");
    const tab = await this.deps.queryActiveTab();
    if (tab.id === null || !Number.isInteger(tab.id) || tab.id < 0 || tab.url === null) {
      throw new Error("RELAY_BIND_UNSUPPORTED_TAB");
    }
    let url: URL;
    try {
      url = new URL(tab.url);
    } catch {
      throw new Error("RELAY_BIND_UNSUPPORTED_TAB");
    }
    if (url.protocol !== "https:" || url.hostname !== "chatgpt.com") {
      throw new Error("RELAY_BIND_UNSUPPORTED_TAB");
    }
    const conversationId = await this.deps.conversationIdentity(tab.id);
    if (conversationId === null || conversationId.length === 0 || conversationId.length > 2048) {
      throw new Error("RELAY_CONVERSATION_UNAVAILABLE");
    }
    await this.deps.bind(tab.id, conversationId);
    return this.view();
  }

  async unbind(): Promise<PopupView> {
    await this.deps.unbind();
    return this.view();
  }

  async unpair(): Promise<PopupView> {
    await this.deps.unpair();
    return this.view();
  }
}

interface WorkerResponse {
  ok: boolean;
  state?: PopupRelayState | null;
  error?: string;
}

interface ChromeLike {
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
  };
  tabs: {
    query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<Array<{ id?: number; url?: string }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
}

declare const chrome: ChromeLike | undefined;

function assertWorkerResponse(value: unknown): WorkerResponse {
  if (value === null || typeof value !== "object") throw new Error("RELAY_WORKER_RESPONSE_INVALID");
  const response = value as WorkerResponse;
  if (response.ok !== true) throw new Error(response.error ?? "RELAY_WORKER_ERROR");
  return response;
}

function browserDependencies(api: ChromeLike): PopupControllerDependencies {
  const worker = async (message: unknown): Promise<WorkerResponse> => (
    assertWorkerResponse(await api.runtime.sendMessage(message))
  );

  return {
    getState: async () => {
      const response = await worker({ type: "popup_get_state" });
      return response.state ?? null;
    },
    pair: async (input) => {
      const response = await fetch(`http://127.0.0.1:${input.relay_port}/pair`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({
          workspace_id: input.workspace_id,
          code: input.code,
          extension_id: input.extension_id,
        }),
      });
      if (!response.ok) throw new Error("RELAY_PAIRING_REJECTED");
      const payload = await response.json() as unknown;
      if (payload === null || typeof payload !== "object") throw new Error("RELAY_PAIRING_RESPONSE_INVALID");
      const record = payload as Record<string, unknown>;
      if (typeof record.workspace_id !== "string" || typeof record.token !== "string") {
        throw new Error("RELAY_PAIRING_RESPONSE_INVALID");
      }
      return { workspace_id: record.workspace_id, token: record.token };
    },
    savePairing: async (input) => {
      await worker({ type: "popup_save_pairing", ...input });
    },
    queryActiveTab: async () => {
      const [tab] = await api.tabs.query({ active: true, currentWindow: true });
      return { id: typeof tab?.id === "number" ? tab.id : null, url: typeof tab?.url === "string" ? tab.url : null };
    },
    conversationIdentity: async (tabId) => {
      const response = await api.tabs.sendMessage(tabId, { type: "chat2codex_conversation_identity" });
      if (response === null || typeof response !== "object") return null;
      const conversationId = (response as { conversation_id?: unknown }).conversation_id;
      return typeof conversationId === "string" ? conversationId : null;
    },
    bind: async (tabId, conversationId) => {
      await worker({ type: "popup_bind", tab_id: tabId, conversation_id: conversationId });
    },
    unbind: async () => {
      await worker({ type: "popup_unbind" });
    },
    unpair: async () => {
      await worker({ type: "popup_unpair" });
    },
    createExtensionId: () => `ext_${crypto.randomUUID()}`,
  };
}

function text(elementId: string, value: string): void {
  const element = document.getElementById(elementId);
  if (element) element.textContent = value;
}

function visible(elementId: string, show: boolean): void {
  const element = document.getElementById(elementId);
  if (element instanceof HTMLElement) element.hidden = !show;
}

function render(view: PopupView): void {
  text("relay-state", view.state);
  text("relay-error", view.error ?? "");
  text("workspace-summary", view.relay?.workspace_id ?? "Not paired");
  text("binding-summary", view.relay?.conversation_id ?? "No ChatGPT conversation bound");
  visible("pair-panel", view.relay === null);
  visible("paired-panel", view.relay !== null);
  visible("bind-button", view.relay !== null && view.state !== "PAIRED_BOUND");
  visible("unbind-button", view.relay !== null && view.state === "PAIRED_BOUND");
}

export function initializePopup(): void {
  if (typeof chrome === "undefined" || typeof document === "undefined") return;
  const controller = new PopupController(browserDependencies(chrome));

  const run = async (action: () => Promise<PopupView>): Promise<void> => {
    try {
      render(await action());
    } catch (error) {
      render(await controller.view(errorMessage(error)));
    }
  };

  const pairForm = document.getElementById("pair-form");
  pairForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    const portInput = document.getElementById("relay-port") as HTMLInputElement | null;
    const workspaceInput = document.getElementById("workspace-id") as HTMLInputElement | null;
    const codeInput = document.getElementById("pairing-code") as HTMLInputElement | null;
    void run(async () => {
      const view = await controller.pair({
        relay_port: Number(portInput?.value ?? ""),
        workspace_id: workspaceInput?.value.trim() ?? "",
        code: codeInput?.value.trim().toUpperCase() ?? "",
      });
      if (codeInput) codeInput.value = "";
      return view;
    });
  });
  document.getElementById("bind-button")?.addEventListener("click", () => {
    void run(() => controller.bindCurrentTab());
  });
  document.getElementById("unbind-button")?.addEventListener("click", () => {
    void run(() => controller.unbind());
  });
  document.getElementById("unpair-button")?.addEventListener("click", () => {
    void run(() => controller.unpair());
  });
  void run(() => controller.view());
}

initializePopup();
