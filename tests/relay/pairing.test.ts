import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStateDir } from "../../src/config/paths.js";
import { RelayPairingService } from "../../src/relay/pairing.js";
import { RelayTokenStore } from "../../src/relay/token-store.js";

const WORKSPACE = "ws_0123456789abcdef";
const OTHER_WORKSPACE = "ws_fedcba9876543210";
const HUMAN_CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

let stateDir: string;

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "chat2codex-relay-pairing-"));
  process.env.CHAT2CODEX_STATE_DIR = stateDir;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-14T08:00:00.000Z"));
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env.CHAT2CODEX_STATE_DIR;
  await rm(stateDir, { recursive: true, force: true });
});

describe("RelayPairingService", () => {
  it("creates an 8-character ambiguity-free code with a 5-minute TTL without persisting plaintext", async () => {
    const pairing = new RelayPairingService(new RelayTokenStore());
    const session = await pairing.create(WORKSPACE);

    expect(session.workspace_id).toBe(WORKSPACE);
    expect(session.code).toMatch(HUMAN_CODE);
    expect(session.attempts_remaining).toBe(5);
    expect(session.expires_at).toBe("2026-09-14T08:05:00.000Z");

    const pairingPath = join(getStateDir(), "relay", WORKSPACE, "pairing.json");
    const raw = await readFile(pairingPath, "utf8");
    expect(raw).not.toContain(session.code);
    expect(JSON.parse(raw)).toMatchObject({
      workspace_id: WORKSPACE,
      attempts_remaining: 5,
    });
    expect(JSON.parse(raw).code_sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exchanges a pairing code once and stores no reusable plaintext credential", async () => {
    const tokenStore = new RelayTokenStore();
    const pairing = new RelayPairingService(tokenStore);
    const session = await pairing.create(WORKSPACE);
    const issued = await pairing.exchange(WORKSPACE, session.code, "ext-test");

    expect(issued.token.length).toBeGreaterThanOrEqual(43);
    expect(await tokenStore.verify(WORKSPACE, "ext-test", issued.token)).toBe(true);
    await expect(pairing.exchange(WORKSPACE, session.code, "ext-test")).rejects.toThrow(
      /PAIRING_CODE_INVALID|PAIRING_CODE_USED/,
    );

    const pairingPath = join(getStateDir(), "relay", WORKSPACE, "pairing.json");
    await expect(readFile(pairingPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows only one concurrent exchange of the same pairing code", async () => {
    const pairing = new RelayPairingService(new RelayTokenStore());
    const session = await pairing.create(WORKSPACE);
    const results = await Promise.allSettled([
      pairing.exchange(WORKSPACE, session.code, "ext-test"),
      pairing.exchange(WORKSPACE, session.code, "ext-test"),
    ]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
  });

  it("rejects exchange from another workspace", async () => {
    const pairing = new RelayPairingService(new RelayTokenStore());
    const session = await pairing.create(WORKSPACE);

    await expect(pairing.exchange(OTHER_WORKSPACE, session.code, "ext-test")).rejects.toThrow(
      /PAIRING_CODE_INVALID|PAIRING_WORKSPACE_MISMATCH/,
    );
  });

  it("expires the code after five minutes", async () => {
    const pairing = new RelayPairingService(new RelayTokenStore());
    const session = await pairing.create(WORKSPACE);
    vi.setSystemTime(new Date("2026-09-14T08:05:00.001Z"));

    await expect(pairing.exchange(WORKSPACE, session.code, "ext-test")).rejects.toThrow(
      /PAIRING_CODE_EXPIRED|PAIRING_CODE_INVALID/,
    );
  });

  it("invalidates a session after five failed attempts", async () => {
    const pairing = new RelayPairingService(new RelayTokenStore());
    const session = await pairing.create(WORKSPACE);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(pairing.exchange(WORKSPACE, "AAAAAAAA", "ext-test")).rejects.toThrow(
        /PAIRING_CODE_INVALID/,
      );
    }

    await expect(pairing.exchange(WORKSPACE, session.code, "ext-test")).rejects.toThrow(
      /PAIRING_CODE_INVALID|PAIRING_ATTEMPTS_EXHAUSTED/,
    );
  });
});
