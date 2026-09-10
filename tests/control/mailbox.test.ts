import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { DoneMessage } from "../../src/protocol/types.js";
import { MailboxTransport } from "../../src/control/mailbox.js";

const message = (taskId: string): DoneMessage => ({
  kind: "DONE",
  workspace_id: "ws_abc123",
  task_id: taskId,
  iteration: 1,
  summary: "done",
});

describe("MailboxTransport", () => {
  it("persists FIFO order and acknowledgements across instances", async () => {
    const stateDir = await mkdtemp(join(tmpdir(), "chat2codex-mailbox-"));
    const first = new MailboxTransport("ws_abc123", "outbox", stateDir);
    const a = await first.publish(message("task_a"));
    const b = await first.publish(message("task_b"));

    const restarted = new MailboxTransport("ws_abc123", "outbox", stateDir);
    expect((await restarted.receive())?.id).toBe(a.id);
    await restarted.acknowledge(a.id);

    const restartedAgain = new MailboxTransport("ws_abc123", "outbox", stateDir);
    expect((await restartedAgain.receive())?.id).toBe(b.id);
  });
});
