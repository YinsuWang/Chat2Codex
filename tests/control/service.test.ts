import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { formatControlText } from "../../src/protocol/text-format.js";
import type { DoneMessage } from "../../src/protocol/types.js";
import { ControlService } from "../../src/control/service.js";

const done = (workspaceId: string): DoneMessage => ({
  kind: "DONE",
  workspace_id: workspaceId,
  task_id: "task_001",
  iteration: 1,
  summary: "done",
});

describe("ControlService", () => {
  it("ingests only matching workspace messages before persistence", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chat2codex-control-"));
    const service = new ControlService("ws_abc123", stateDir);
    const envelope = await service.ingest(formatControlText(done("ws_abc123")));
    expect((await service.receiveInbound())?.id).toBe(envelope.id);

    await expect(service.ingest(formatControlText(done("ws_other")))).rejects.toThrow("WORKSPACE_MISMATCH");
    const inbox = await readdir(join(stateDir, "control", "ws_abc123", "inbox"));
    expect(inbox).toHaveLength(1);
  });

  it("publishes, reads, and acknowledges outbound messages", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chat2codex-control-"));
    const service = new ControlService("ws_abc123", stateDir);
    const published = await service.publishOutbound(done("ws_abc123"));
    expect((await service.next("ws_abc123"))?.id).toBe(published.id);
    await service.acknowledgeOutbound(published.id);
    expect(await service.next("ws_abc123")).toBeNull();
  });
});
