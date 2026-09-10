import { parseControlText } from "../protocol/text-format.js";
import type { ControlMessage } from "../protocol/types.js";
import { MailboxTransport } from "./mailbox.js";
import type { ControlEnvelope } from "./transport.js";

export class ControlService {
  private readonly inbound: MailboxTransport;
  private readonly outbound: MailboxTransport;

  constructor(private readonly workspaceId: string, stateDir?: string) {
    this.inbound = new MailboxTransport(workspaceId, "inbox", stateDir);
    this.outbound = new MailboxTransport(workspaceId, "outbox", stateDir);
  }

  async ingest(text: string): Promise<ControlEnvelope> {
    const message = parseControlText(text);
    if (message.workspace_id !== this.workspaceId) {
      throw new Error(`WORKSPACE_MISMATCH: ${message.workspace_id} != ${this.workspaceId}`);
    }
    return this.inbound.publish(message);
  }

  async receiveInbound(): Promise<ControlEnvelope | null> {
    return this.inbound.receive();
  }

  async acknowledgeInbound(id: string): Promise<void> {
    await this.inbound.acknowledge(id);
  }

  async publishOutbound(message: ControlMessage): Promise<ControlEnvelope> {
    return this.outbound.publish(message);
  }

  async next(workspaceId = this.workspaceId): Promise<ControlEnvelope | null> {
    if (workspaceId !== this.workspaceId) {
      throw new Error(`WORKSPACE_MISMATCH: ${workspaceId} != ${this.workspaceId}`);
    }
    return this.outbound.receive();
  }

  async acknowledgeOutbound(id: string): Promise<void> {
    await this.outbound.acknowledge(id);
  }
}
