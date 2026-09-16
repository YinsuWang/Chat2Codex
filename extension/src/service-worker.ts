import {
  isRelayClientFrame,
  parseRelayServerFrame,
  serializeRelayClientFrame,
  type RelayClientFrame,
  type RelayServerFrame,
} from "./protocol.js";

export const EXTENSION_RELAY_STATE_KEY = "chat2codex_relay_state";
const KEEPALIVE_MS = 20_000;
const SOCKET_OPEN = 1;
const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;

export interface ExtensionRelayState {
  workspace_id: string;
  workspace_name: string;
  relay_port: number;
  relay_token: string;
  extension_id: string;
  bound_tab_id: number | null;
  conversation_id: string | null;
}

interface PublicRelayState {
  workspace_id: string;
  workspace_name: string;
  relay_port: number;
  extension_id: string;
  bound_tab_id: number | null;
  conversation_id: string | null;
}

export type RelayStatus = "connected" | "disconnected" | "auth_failed";
export interface RelaySocket {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}
export interface RelayWorkerDependencies {
  loadState(key: string): Promise<ExtensionRelayState | null>;
  createSocket(url: string): RelaySocket;
  sendToTab(tabId: number, message: unknown): Promise<void>;
  publishStatus(status: RelayStatus): Promise<void>;
  setTimeout(callback: () => void, delay: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(callback: () => void, delay: number): unknown;
  clearInterval(handle: unknown): void;
  now(): Date;
}

export function reconnectDelayMs(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.max(0, attempt));
}

function validState(value: ExtensionRelayState | null): value is ExtensionRelayState {
  return value !== null
    && WORKSPACE_ID_PATTERN.test(value.workspace_id)
    && typeof value.workspace_name === "string"
    && Number.isInteger(value.relay_port) && value.relay_port >= 1 && value.relay_port <= 65535
    && typeof value.relay_token === "string" && value.relay_token.length > 0 && value.relay_token.length <= 256
    && typeof value.extension_id === "string" && value.extension_id.length > 0 && value.extension_id.length <= 256
    && (value.bound_tab_id === null || (Number.isInteger(value.bound_tab_id) && value.bound_tab_id >= 0))
    && (value.conversation_id === null || (typeof value.conversation_id === "string" && value.conversation_id.length > 0 && value.conversation_id.length <= 2048));
}

function publicState(state: ExtensionRelayState): PublicRelayState {
  return {
    workspace_id: state.workspace_id,
    workspace_name: state.workspace_name,
    relay_port: state.relay_port,
    extension_id: state.extension_id,
    bound_tab_id: state.bound_tab_id,
    conversation_id: state.conversation_id,
  };
}

export class ExtensionRelayClient {
  private state: ExtensionRelayState | null = null;
  private socket: RelaySocket | null = null;
  private authenticated = false;
  private stopped = false;
  private authFailed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: unknown = null;
  private keepaliveTimer: unknown = null;
  private readonly deliveredEnvelopeIds = new Set<string>();

  constructor(private readonly deps: RelayWorkerDependencies) {}

  async start(): Promise<void> {
    this.stopped = false;
    this.authFailed = false;
    const state = await this.deps.loadState(EXTENSION_RELAY_STATE_KEY);
    if (!validState(state)) {
      this.state = null;
      await this.deps.publishStatus("disconnected");
      return;
    }
    this.state = state;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.authenticated = false;
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }

  handleContentMessage(value: unknown, senderTabId: number): boolean {
    if (!this.state || senderTabId !== this.state.bound_tab_id || !isRelayClientFrame(value)) return false;
    if (value.type === "hello" || value.type === "keepalive" || value.workspace_id !== this.state.workspace_id) return false;
    if (!this.authenticated || this.socket?.readyState !== SOCKET_OPEN) return false;
    this.socket.send(serializeRelayClientFrame(value));
    return true;
  }

  private connect(): void {
    if (this.stopped || this.authFailed || !this.state) return;
    const socket = this.deps.createSocket(`ws://127.0.0.1:${this.state.relay_port}`);
    this.socket = socket;
    this.authenticated = false;
    socket.onopen = () => {
      if (!this.state || socket !== this.socket) return;
      socket.send(serializeRelayClientFrame({ type: "hello", workspace_id: this.state.workspace_id, token: this.state.relay_token, extension_id: this.state.extension_id }));
    };
    socket.onmessage = (event) => { void this.onServerMessage(event.data, socket); };
    socket.onerror = () => { socket.close(); };
    socket.onclose = () => { void this.onClosed(socket); };
  }

  private async onServerMessage(text: string, socket: RelaySocket): Promise<void> {
    if (!this.state || socket !== this.socket) return;
    const frame = parseRelayServerFrame(text);
    if (!frame) {
      await this.failClosed(socket, "disconnected");
      return;
    }
    if (frame.type === "relay_error") {
      const authFailure = frame.code === "AUTH_FAILED" || frame.code === "RELAY_AUTH_FAILED" || frame.code === "AUTH_REVOKED";
      if (authFailure) this.authFailed = true;
      await this.failClosed(socket, authFailure ? "auth_failed" : "disconnected");
      return;
    }
    if (frame.workspace_id !== this.state.workspace_id) {
      await this.failClosed(socket, "disconnected");
      return;
    }
    if (frame.type === "hello_ok") {
      this.authenticated = true;
      this.reconnectAttempt = 0;
      this.startKeepalive();
      await this.deps.publishStatus("connected");
      return;
    }
    if (!this.authenticated) return;
    if (frame.type === "outbound_control") await this.forwardOutbound(frame);
  }

  private async forwardOutbound(frame: Extract<RelayServerFrame, { type: "outbound_control" }>): Promise<void> {
    if (!this.state || this.state.bound_tab_id === null || this.deliveredEnvelopeIds.has(frame.envelope_id)) return;
    this.deliveredEnvelopeIds.add(frame.envelope_id);
    try {
      await this.deps.sendToTab(this.state.bound_tab_id, { type: "deliver_control", workspace_id: frame.workspace_id, envelope_id: frame.envelope_id, text: frame.text });
    } catch {
      this.deliveredEnvelopeIds.delete(frame.envelope_id);
      await this.deps.publishStatus("disconnected");
    }
  }

  private startKeepalive(): void {
    if (this.keepaliveTimer !== null) this.deps.clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = this.deps.setInterval(() => {
      if (!this.state || !this.authenticated || this.socket?.readyState !== SOCKET_OPEN) return;
      const frame: RelayClientFrame = { type: "keepalive", workspace_id: this.state.workspace_id, at: this.deps.now().toISOString() };
      this.socket.send(serializeRelayClientFrame(frame));
    }, KEEPALIVE_MS);
  }

  private async failClosed(socket: RelaySocket, status: RelayStatus): Promise<void> {
    if (socket !== this.socket) return;
    this.authenticated = false;
    await this.deps.publishStatus(status);
    socket.close();
  }

  private async onClosed(socket: RelaySocket): Promise<void> {
    if (socket !== this.socket) return;
    this.authenticated = false;
    if (this.keepaliveTimer !== null) {
      this.deps.clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    if (this.authFailed || this.stopped) return;
    await this.deps.publishStatus("disconnected");
    const delay = reconnectDelayMs(this.reconnectAttempt++);
    this.reconnectTimer = this.deps.setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private clearTimers(): void {
    if (this.reconnectTimer !== null) this.deps.clearTimeout(this.reconnectTimer);
    if (this.keepaliveTimer !== null) this.deps.clearInterval(this.keepaliveTimer);
    this.reconnectTimer = null;
    this.keepaliveTimer = null;
  }
}

interface PopupGetStateMessage { type: "popup_get_state"; }
interface PopupSavePairingMessage {
  type: "popup_save_pairing";
  workspace_id: string;
  relay_port: number;
  relay_token: string;
  extension_id: string;
}
interface PopupBindMessage { type: "popup_bind"; tab_id: number; conversation_id: string; }
interface PopupUnbindMessage { type: "popup_unbind"; }
interface PopupUnpairMessage { type: "popup_unpair"; }
type PopupWorkerMessage = PopupGetStateMessage | PopupSavePairingMessage | PopupBindMessage | PopupUnbindMessage | PopupUnpairMessage;

function popupMessage(value: unknown): PopupWorkerMessage | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  switch (record.type) {
    case "popup_get_state":
    case "popup_unbind":
    case "popup_unpair":
      return { type: record.type } as PopupWorkerMessage;
    case "popup_save_pairing":
      if (
        typeof record.workspace_id !== "string" || !WORKSPACE_ID_PATTERN.test(record.workspace_id) ||
        typeof record.relay_port !== "number" || !Number.isInteger(record.relay_port) || record.relay_port < 1 || record.relay_port > 65535 ||
        typeof record.relay_token !== "string" || record.relay_token.length < 1 || record.relay_token.length > 256 ||
        typeof record.extension_id !== "string" || record.extension_id.length < 1 || record.extension_id.length > 256
      ) return null;
      return {
        type: "popup_save_pairing",
        workspace_id: record.workspace_id,
        relay_port: record.relay_port,
        relay_token: record.relay_token,
        extension_id: record.extension_id,
      };
    case "popup_bind":
      if (
        typeof record.tab_id !== "number" || !Number.isInteger(record.tab_id) || record.tab_id < 0 ||
        typeof record.conversation_id !== "string" || record.conversation_id.length < 1 || record.conversation_id.length > 2048
      ) return null;
      return { type: "popup_bind", tab_id: record.tab_id, conversation_id: record.conversation_id };
    default:
      return null;
  }
}

interface ChromeLike {
  storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
  tabs: { sendMessage(tabId: number, message: unknown): Promise<unknown> };
  runtime: {
    onMessage: {
      addListener(listener: (
        message: unknown,
        sender: { tab?: { id?: number } },
        sendResponse: (response: unknown) => void,
      ) => boolean | void): void;
    };
  };
}
declare const chrome: ChromeLike | undefined;

function browserDependencies(api: ChromeLike): RelayWorkerDependencies {
  return {
    loadState: async (key) => {
      const record = await api.storage.local.get(key);
      return (record[key] ?? null) as ExtensionRelayState | null;
    },
    createSocket: (url) => new WebSocket(url) as unknown as RelaySocket,
    sendToTab: async (tabId, message) => { await api.tabs.sendMessage(tabId, message); },
    publishStatus: async (state) => {
      const record = await api.storage.local.get(EXTENSION_RELAY_STATE_KEY);
      const saved = record[EXTENSION_RELAY_STATE_KEY] as Partial<ExtensionRelayState> | undefined;
      if (typeof saved?.bound_tab_id === "number") {
        await api.tabs.sendMessage(saved.bound_tab_id, { type: "relay_status", state }).catch(() => undefined);
      }
    },
    setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
    setInterval: (callback, delay) => globalThis.setInterval(callback, delay),
    clearInterval: (handle) => globalThis.clearInterval(handle as number),
    now: () => new Date(),
  };
}

async function loadFullState(api: ChromeLike): Promise<ExtensionRelayState | null> {
  const record = await api.storage.local.get(EXTENSION_RELAY_STATE_KEY);
  const state = (record[EXTENSION_RELAY_STATE_KEY] ?? null) as ExtensionRelayState | null;
  return validState(state) ? state : null;
}

async function restartRelayClient(client: ExtensionRelayClient): Promise<void> {
  client.stop();
  await client.start();
}

async function handlePopupMessage(
  message: PopupWorkerMessage,
  api: ChromeLike,
  relayClient: ExtensionRelayClient,
): Promise<{ ok: true; state?: PublicRelayState | null }> {
  if (message.type === "popup_get_state") {
    const state = await loadFullState(api);
    return { ok: true, state: state ? publicState(state) : null };
  }

  if (message.type === "popup_save_pairing") {
    const state: ExtensionRelayState = {
      workspace_id: message.workspace_id,
      workspace_name: message.workspace_id,
      relay_port: message.relay_port,
      relay_token: message.relay_token,
      extension_id: message.extension_id,
      bound_tab_id: null,
      conversation_id: null,
    };
    if (!validState(state)) throw new Error("RELAY_STATE_INVALID");
    await api.storage.local.set({ [EXTENSION_RELAY_STATE_KEY]: state });
    await restartRelayClient(relayClient);
    return { ok: true, state: publicState(state) };
  }

  const state = await loadFullState(api);
  if (!state) throw new Error("RELAY_NOT_PAIRED");

  if (message.type === "popup_bind") {
    const next = { ...state, bound_tab_id: message.tab_id, conversation_id: message.conversation_id };
    await api.storage.local.set({ [EXTENSION_RELAY_STATE_KEY]: next });
    await restartRelayClient(relayClient);
    return { ok: true, state: publicState(next) };
  }

  if (message.type === "popup_unbind") {
    const next = { ...state, bound_tab_id: null, conversation_id: null };
    await api.storage.local.set({ [EXTENSION_RELAY_STATE_KEY]: next });
    await restartRelayClient(relayClient);
    return { ok: true, state: publicState(next) };
  }

  const response = await fetch(`http://127.0.0.1:${state.relay_port}/unpair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({
      workspace_id: state.workspace_id,
      extension_id: state.extension_id,
      token: state.relay_token,
    }),
  });
  if (!response.ok) throw new Error("RELAY_UNPAIR_REJECTED");
  await api.storage.local.remove(EXTENSION_RELAY_STATE_KEY);
  relayClient.stop();
  return { ok: true, state: null };
}

if (typeof chrome !== "undefined") {
  const relayClient = new ExtensionRelayClient(browserDependencies(chrome));
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const command = popupMessage(message);
    if (command) {
      if (sender.tab !== undefined) {
        sendResponse({ ok: false, error: "RELAY_POPUP_COMMAND_REJECTED" });
        return false;
      }
      void handlePopupMessage(command, chrome, relayClient)
        .then((response) => sendResponse(response))
        .catch((error: unknown) => sendResponse({
          ok: false,
          error: error instanceof Error ? error.message : "RELAY_WORKER_ERROR",
        }));
      return true;
    }

    const tabId = sender.tab?.id;
    if (typeof tabId === "number") relayClient.handleContentMessage(message, tabId);
    return undefined;
  });
  void relayClient.start();
}
