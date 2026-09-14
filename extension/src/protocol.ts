export const MAX_CONTROL_TEXT_BYTES = 16 * 1024;
export const MAX_RELAY_FRAME_BYTES = 24 * 1024;

export type RelayClientFrame =
  | { type: "hello"; workspace_id: string; token: string; extension_id: string }
  | { type: "keepalive"; workspace_id: string; at: string }
  | { type: "outbound_sent"; workspace_id: string; envelope_id: string }
  | { type: "assistant_control"; workspace_id: string; text: string; fingerprint: string }
  | { type: "tab_heartbeat"; workspace_id: string; conversation_id: string };

export type RelayServerFrame =
  | { type: "hello_ok"; workspace_id: string; server_time: string }
  | { type: "outbound_control"; workspace_id: string; envelope_id: string; text: string }
  | { type: "assistant_ingested"; workspace_id: string; fingerprint: string }
  | { type: "relay_error"; code: string; detail: string };

export type RelayFrame = RelayClientFrame | RelayServerFrame;

const SERVER_FRAME_TYPES = new Set<RelayServerFrame["type"]>([
  "hello_ok",
  "outbound_control",
  "assistant_ingested",
  "relay_error",
]);

export function isRelayServerFrame(value: unknown): value is RelayServerFrame {
  if (!value || typeof value !== "object") return false;
  const type = (value as { type?: unknown }).type;
  return typeof type === "string" && SERVER_FRAME_TYPES.has(type as RelayServerFrame["type"]);
}
