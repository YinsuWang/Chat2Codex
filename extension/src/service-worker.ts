import { isRelayServerFrame } from "./protocol.js";

export function parseServerFrameForExtension(value: unknown): boolean {
  return isRelayServerFrame(value);
}
