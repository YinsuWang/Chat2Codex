import type { ControlMessage } from "./types.js";
import { parseControlMessage } from "./schemas.js";

export const CONTROL_TEXT_MARKER = "[CHAT2CODEX]";
export const MAX_CONTROL_TEXT_BYTES = 16 * 1024;

export function formatControlText(message: ControlMessage): string {
  return `${CONTROL_TEXT_MARKER}\n${JSON.stringify(message)}`;
}

export function parseControlText(text: string): ControlMessage {
  if (Buffer.byteLength(text, "utf8") > MAX_CONTROL_TEXT_BYTES) {
    throw new Error(`Control message exceeds ${MAX_CONTROL_TEXT_BYTES} bytes`);
  }

  const prefix = `${CONTROL_TEXT_MARKER}\n`;
  if (!text.startsWith(prefix)) {
    throw new Error(`Control message must start with ${CONTROL_TEXT_MARKER}`);
  }

  const payload = text.slice(prefix.length);
  if (payload.length === 0) {
    throw new Error("Control message JSON payload is empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch (error) {
    throw new Error("Control message payload is not valid JSON", { cause: error });
  }

  return parseControlMessage(parsed);
}
