export const MAX_CONTROL_TEXT_BYTES = 16 * 1024;
export const MAX_RELAY_FRAME_BYTES = 24 * 1024;
export const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validWorkspace(value: unknown): value is string {
  return typeof value === "string" && WORKSPACE_ID_PATTERN.test(value);
}
function boundedString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function validControlText(value: unknown): value is string {
  return typeof value === "string" && new TextEncoder().encode(value).byteLength <= MAX_CONTROL_TEXT_BYTES;
}
function validDateTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

export function isRelayServerFrame(value: unknown): value is RelayServerFrame {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello_ok": return validWorkspace(value.workspace_id) && validDateTime(value.server_time);
    case "outbound_control": return validWorkspace(value.workspace_id) && boundedString(value.envelope_id) && validControlText(value.text);
    case "assistant_ingested": return validWorkspace(value.workspace_id) && boundedString(value.fingerprint);
    case "relay_error": return boundedString(value.code) && typeof value.detail === "string" && value.detail.length <= MAX_CONTROL_TEXT_BYTES;
    default: return false;
  }
}

export function isRelayClientFrame(value: unknown): value is RelayClientFrame {
  if (!isRecord(value) || !validWorkspace(value.workspace_id) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "hello": return boundedString(value.token) && boundedString(value.extension_id);
    case "keepalive": return validDateTime(value.at);
    case "outbound_sent": return boundedString(value.envelope_id);
    case "assistant_control": return validControlText(value.text) && boundedString(value.fingerprint);
    case "tab_heartbeat": return boundedString(value.conversation_id, 2048);
    default: return false;
  }
}

export function parseRelayServerFrame(text: string): RelayServerFrame | null {
  if (new TextEncoder().encode(text).byteLength > MAX_RELAY_FRAME_BYTES) return null;
  try {
    const value: unknown = JSON.parse(text);
    return isRelayServerFrame(value) ? value : null;
  } catch {
    return null;
  }
}

export function serializeRelayClientFrame(frame: RelayClientFrame): string {
  if (!isRelayClientFrame(frame)) throw new Error("RELAY_CLIENT_FRAME_INVALID");
  const text = JSON.stringify(frame);
  if (new TextEncoder().encode(text).byteLength > MAX_RELAY_FRAME_BYTES) throw new Error("RELAY_FRAME_TOO_LARGE");
  return text;
}
