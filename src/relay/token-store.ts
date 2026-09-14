import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getStateDir } from "../config/paths.js";

const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;
const EXTENSION_ID_MAX_LENGTH = 256;

const RelayAuthorizationRecordSchema = z.strictObject({
  workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
  extension_id: z.string().min(1).max(EXTENSION_ID_MAX_LENGTH),
  token_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  issued_at: z.string().datetime(),
  revoked_at: z.string().datetime().nullable(),
});

export interface RelayAuthorizationRecord {
  workspace_id: string;
  extension_id: string;
  token_sha256: string;
  issued_at: string;
  revoked_at: string | null;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`INVALID_WORKSPACE_ID: ${workspaceId}`);
  }
}

function assertExtensionId(extensionId: string): void {
  if (extensionId.length < 1 || extensionId.length > EXTENSION_ID_MAX_LENGTH) {
    throw new Error("INVALID_EXTENSION_ID");
  }
}

function authorizationPath(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return join(getStateDir(), "relay", workspaceId, "authorization.json");
}

function tokenHash(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

async function atomicWrite(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

async function readAuthorization(workspaceId: string): Promise<RelayAuthorizationRecord | null> {
  const path = authorizationPath(workspaceId);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  try {
    return RelayAuthorizationRecordSchema.parse(JSON.parse(raw) as unknown);
  } catch {
    throw new Error("INVALID_RELAY_AUTHORIZATION");
  }
}

function hashesEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export class RelayTokenStore {
  async issue(workspaceId: string, extensionId: string): Promise<string> {
    assertWorkspaceId(workspaceId);
    assertExtensionId(extensionId);
    const rawToken = randomBytes(32).toString("base64url");
    const record: RelayAuthorizationRecord = {
      workspace_id: workspaceId,
      extension_id: extensionId,
      token_sha256: tokenHash(rawToken),
      issued_at: new Date().toISOString(),
      revoked_at: null,
    };
    await atomicWrite(authorizationPath(workspaceId), record);
    return rawToken;
  }

  async verify(workspaceId: string, extensionId: string, rawToken: string): Promise<boolean> {
    assertWorkspaceId(workspaceId);
    assertExtensionId(extensionId);
    const record = await readAuthorization(workspaceId);
    if (!record || record.revoked_at !== null) return false;
    if (record.workspace_id !== workspaceId || record.extension_id !== extensionId) return false;
    return hashesEqual(record.token_sha256, tokenHash(rawToken));
  }

  async revokeWorkspace(workspaceId: string): Promise<void> {
    const record = await readAuthorization(workspaceId);
    if (!record || record.revoked_at !== null) return;
    await atomicWrite(authorizationPath(workspaceId), {
      ...record,
      revoked_at: new Date().toISOString(),
    });
  }

  async status(workspaceId: string): Promise<{ paired: boolean; extension_id: string | null }> {
    const record = await readAuthorization(workspaceId);
    if (!record || record.revoked_at !== null) {
      return { paired: false, extension_id: null };
    }
    return { paired: true, extension_id: record.extension_id };
  }
}
