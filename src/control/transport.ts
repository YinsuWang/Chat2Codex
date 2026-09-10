import type { ControlMessage } from "../protocol/types.js";

export interface ControlEnvelope {
  id: string;
  created_at: string;
  message: ControlMessage;
}

export interface ControlTransport {
  publish(message: ControlMessage): Promise<ControlEnvelope>;
  receive(): Promise<ControlEnvelope | null>;
  acknowledge(id: string): Promise<void>;
}
