import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getStateDir } from "../config/paths.js";
import { RelayTokenStore } from "./token-store.js";

const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;
const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const PAIRING_CODE_LENGTH = 8;
const PAIRING_TTL_MS = 5 * 60 * 1000;
const PAIRING_MAX_ATTEMPTS = 5;

const PersistedPairingSchema = z.strictObject({
  pairing_id: z.string().regex(/^pair_[a-f0-9]{16}$/),
  workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
  code_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  attempts_remaining: z.number().int().min(1).max(PAIRING_MAX_ATTEMPTS),
});

type PersistedPairing = z.infer<typeof PersistedPairingSchema>;

export interface PairingSession {
  pairing_id: string;
  workspace_id: string;
  code: string;
  expires_at: string;
  attempts_remaining: number;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`INVALID_WORKSPACE_ID: ${workspaceId}`);
  }
}

function pairingPath(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return join(getStateDir(), "relay", workspaceId, "pairing.json");
}

function codeHash(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function createHumanCode(): string {
  let code = "";
  for (let index = 0; index < PAIRING_CODE_LENGTH; index += 1) {
    code += PAIRING_ALPHABET.charAt(randomInt(PAIRING_ALPHABET.length));
  }
  return code;
}

async function atomicWrite(path: string, value: PersistedPairing): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readPairing(workspaceId: string): Promise<PersistedPairing | null> {
  const path = pairingPath(workspaceId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    return PersistedPairingSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new Error("INVALID_RELAY_PAIRING_STATE");
  }
}

export class RelayPairingService {
  private readonly queues = new Map<string, Promise<void>>();

  constructor(private readonly tokenStore = new RelayTokenStore()) {}

  async create(workspaceId: string): Promise<PairingSession> {
    assertWorkspaceId(workspaceId);
    const now = Date.now();
    const code = createHumanCode();
    const record: PersistedPairing = {
      pairing_id: `pair_${randomBytes(8).toString("hex")}`,
      workspace_id: workspaceId,
      code_sha256: codeHash(code),
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + PAIRING_TTL_MS).toISOString(),
      attempts_remaining: PAIRING_MAX_ATTEMPTS,
    };
    await atomicWrite(pairingPath(workspaceId), record);
    return {
      pairing_id: record.pairing_id,
      workspace_id: workspaceId,
      code,
      expires_at: record.expires_at,
      attempts_remaining: record.attempts_remaining,
    };
  }

  async exchange(
    workspaceId: string,
    code: string,
    extensionId: string,
  ): Promise<{ token: string }> {
    return this.serialized(workspaceId, async () => {
      const path = pairingPath(workspaceId);
      const record = await readPairing(workspaceId);
      if (!record) throw new Error("PAIRING_CODE_INVALID");

      if (Date.now() >= Date.parse(record.expires_at)) {
        await rm(path, { force: true });
        throw new Error("PAIRING_CODE_EXPIRED");
      }

      if (!hashesEqual(record.code_sha256, codeHash(code))) {
        if (record.attempts_remaining <= 1) {
          await rm(path, { force: true });
        } else {
          await atomicWrite(path, {
            ...record,
            attempts_remaining: record.attempts_remaining - 1,
          });
        }
        throw new Error("PAIRING_CODE_INVALID");
      }

      const consumed = `${path}.consumed.${process.pid}.${randomBytes(6).toString("hex")}`;
      try {
        await rename(path, consumed);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error("PAIRING_CODE_USED");
        }
        throw error;
      }

      try {
        const token = await this.tokenStore.issue(workspaceId, extensionId);
        return { token };
      } finally {
        await rm(consumed, { force: true });
      }
    });
  }

  private async serialized<T>(workspaceId: string, action: () => Promise<T>): Promise<T> {
    assertWorkspaceId(workspaceId);
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => gate);
    this.queues.set(workspaceId, tail);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.queues.get(workspaceId) === tail) this.queues.delete(workspaceId);
    }
  }
}
