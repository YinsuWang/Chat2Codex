import { ChatGptSurfaceAdapter } from "./chat-surface.js";
import type { RelayClientFrame } from "./protocol.js";

const EXTENSION_RELAY_STATE_KEY = "chat2codex_relay_state";

interface ContentRelayState {
  workspace_id: string;
  conversation_id: string | null;
}
interface DeliverControlMessage {
  type: "deliver_control";
  workspace_id: string;
  envelope_id: string;
  text: string;
}
interface ChromeLike {
  storage: { local: { get(key: string): Promise<Record<string, unknown>> } };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown) => void): void };
  };
}
declare const chrome: ChromeLike | undefined;

function isDeliverControl(value: unknown): value is DeliverControlMessage {
  if (value === null || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.type === "deliver_control"
    && typeof record.workspace_id === "string"
    && typeof record.envelope_id === "string"
    && typeof record.text === "string";
}

async function fingerprint(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function initializeContentScript(api: ChromeLike, documentRef: Document, locationRef: Location): () => void {
  const surface = new ChatGptSurfaceAdapter({ document: documentRef, location: locationRef });

  const loadState = async (): Promise<ContentRelayState | null> => {
    const record = await api.storage.local.get(EXTENSION_RELAY_STATE_KEY);
    const value = record[EXTENSION_RELAY_STATE_KEY];
    if (value === null || typeof value !== "object") return null;
    const state = value as Partial<ContentRelayState>;
    if (typeof state.workspace_id !== "string") return null;
    return { workspace_id: state.workspace_id, conversation_id: typeof state.conversation_id === "string" ? state.conversation_id : null };
  };

  const sendHeartbeat = async (state: ContentRelayState, conversationId: string | null): Promise<void> => {
    if (!conversationId) return;
    const frame: RelayClientFrame = { type: "tab_heartbeat", workspace_id: state.workspace_id, conversation_id: conversationId };
    await api.runtime.sendMessage(frame);
  };

  const handleAssistantControl = async (text: string): Promise<void> => {
    try {
      const state = await loadState();
      if (!state) return;
      const conversationId = await surface.conversationIdentity();
      if (state.conversation_id !== null && state.conversation_id !== conversationId) return;
      await sendHeartbeat(state, conversationId);
      const frame: RelayClientFrame = { type: "assistant_control", workspace_id: state.workspace_id, text, fingerprint: await fingerprint(text) };
      await api.runtime.sendMessage(frame);
    } catch {
      // Fail closed: never mutate the page or retry an unvalidated upstream control here.
    }
  };

  const handleDelivery = async (message: DeliverControlMessage): Promise<void> => {
    try {
      const state = await loadState();
      if (!state || state.workspace_id !== message.workspace_id || !(await surface.isSupported())) return;
      const conversationId = await surface.conversationIdentity();
      if (state.conversation_id !== null && state.conversation_id !== conversationId) return;
      await sendHeartbeat(state, conversationId);
      await surface.sendControlText(message.text);
      const frame: RelayClientFrame = { type: "outbound_sent", workspace_id: state.workspace_id, envelope_id: message.envelope_id };
      await api.runtime.sendMessage(frame);
    } catch {
      // The durable server mailbox remains unacknowledged and can be retried safely.
    }
  };

  const stopObserver = surface.observeAssistantControls((text) => { void handleAssistantControl(text); });
  api.runtime.onMessage.addListener((message) => {
    if (isDeliverControl(message)) void handleDelivery(message);
  });
  void (async () => {
    try {
      const state = await loadState();
      if (state) await sendHeartbeat(state, await surface.conversationIdentity());
    } catch {
      // Status heartbeat is best-effort; relay data stays fail-closed.
    }
  })();

  return stopObserver;
}

if (typeof chrome !== "undefined") initializeContentScript(chrome, document, location);
