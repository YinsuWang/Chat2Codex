import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { RelayStatusStore } from "../../src/relay/status.js";

const WORKSPACE = "ws_0123456789abcdef";
let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-status-"));
});

afterEach(async () => {
  await rm(stateDir, { recursive: true, force: true });
});

describe("RelayStatusStore", () => {
  it("preserves workspace dedupe history when a different extension is paired", async () => {
    const store = new RelayStatusStore(stateDir);
    await store.markAuthenticated(WORKSPACE, "ext-old");
    await store.recordHeartbeat(WORKSPACE, "ext-old", "chat-old");
    await store.recordFingerprint(WORKSPACE, "ext-old", "sha256:review-1");

    await store.markAuthenticated(WORKSPACE, "ext-new");

    expect(await store.hasFingerprint(WORKSPACE, "sha256:review-1")).toBe(true);
    expect(await store.get(WORKSPACE)).toMatchObject({
      workspace_id: WORKSPACE,
      extension_id: "ext-new",
      conversation_id: null,
      last_heartbeat_at: null,
      recent_fingerprints: ["sha256:review-1"],
    });
  });

  it("keeps only the 128 most recent unique fingerprints", async () => {
    const store = new RelayStatusStore(stateDir);
    await store.markAuthenticated(WORKSPACE, "ext-1");
    for (let index = 0; index < 130; index += 1) {
      await store.recordFingerprint(WORKSPACE, "ext-1", `sha256:${index}`);
    }

    const status = await store.get(WORKSPACE);
    expect(status?.recent_fingerprints).toHaveLength(128);
    expect(status?.recent_fingerprints[0]).toBe("sha256:2");
    expect(status?.recent_fingerprints.at(-1)).toBe("sha256:129");
  });
});
