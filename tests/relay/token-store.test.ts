import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getStateDir } from "../../src/config/paths.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";

const WORKSPACE = "ws_0123456789abcdef";
const OTHER_WORKSPACE = "ws_fedcba9876543210";

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-token-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
});

afterEach(async () => {
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("RelayTokenStore", () => {
  it("issues a high-entropy token and persists only its hash", async () => {
    const store = new RelayTokenStore();
    const token = await store.issue(WORKSPACE, "ext-1");

    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(await store.verify(WORKSPACE, "ext-1", token)).toBe(true);
    expect(await store.verify(WORKSPACE, "ext-2", token)).toBe(false);
    expect(await store.verify(OTHER_WORKSPACE, "ext-1", token)).toBe(false);

    const authorizationPath = join(getStateDir(), "relay", WORKSPACE, "authorization.json");
    const raw = await readFile(authorizationPath, "utf8");
    const persisted = JSON.parse(raw) as Record<string, unknown>;
    expect(raw).not.toContain(token);
    expect(persisted).toMatchObject({
      workspace_id: WORKSPACE,
      extension_id: "ext-1",
      revoked_at: null,
    });
    expect(persisted.token_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("revokes the current workspace authorization", async () => {
    const store = new RelayTokenStore();
    const token = await store.issue(WORKSPACE, "ext-1");
    await store.revokeWorkspace(WORKSPACE);

    expect(await store.verify(WORKSPACE, "ext-1", token)).toBe(false);
    expect(await store.status(WORKSPACE)).toEqual({ paired: false, extension_id: null });
  });

  it("rejects malformed persisted authorization records", async () => {
    const store = new RelayTokenStore();
    const token = await store.issue(WORKSPACE, "ext-1");
    const authorizationPath = join(getStateDir(), "relay", WORKSPACE, "authorization.json");
    await writeFile(
      authorizationPath,
      `${JSON.stringify({ workspace_id: WORKSPACE, token_sha256: "bad" })}\n`,
      "utf8",
    );

    await expect(store.verify(WORKSPACE, "ext-1", token)).rejects.toThrow(
      /INVALID_RELAY_AUTHORIZATION/,
    );
  });
});
