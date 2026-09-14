import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

import { getStateDir } from "../config/paths.js";

const WORKSPACE_ID_PATTERN = /^ws_[a-f0-9]{16}$/;
const MAX_RECENT_FINGERPRINTS = 128;

const RelayStatusStateSchema = z.strictObject({
  workspace_id: z.string().regex(WORKSPACE_ID_PATTERN),
  extension_id: z.string().min(1).max(256),
  conversation_id: z.string().min(1).max(2048).nullable(),
  last_heartbeat_at: z.string().datetime().nullable(),
  recent_fingerprints: z.array(z.string().min(1).max(256)).max(MAX_RECENT_FINGERPRINTS),
});

export type RelayStatusState = z.infer<typeof RelayStatusStateSchema>;

function assertWorkspaceId(workspaceId: string): void {
  if (!WORKSPACE_ID_PATTERN.test(workspaceId)) {
    throw new Error(`INVALID_WORKSPACE_ID: ${workspaceId}`);
  }
}

export class RelayStatusStore {
  constructor(private readonly stateDir = getStateDir()) {}

  private path(workspaceId: string): string {
    assertWorkspaceId(workspaceId);
    return join(this.stateDir, "relay", workspaceId, "status.json");
  }

  async get(workspaceId: string): Promise<RelayStatusState | null> {
    const path = this.path(workspaceId);
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }

    try {
      const parsed = RelayStatusStateSchema.parse(JSON.parse(raw) as unknown);
      if (parsed.workspace_id !== workspaceId) throw new Error("WORKSPACE_MISMATCH");
      return parsed;
    } catch {
      throw new Error("INVALID_RELAY_STATUS");
    }
  }

  async markAuthenticated(workspaceId: string, extensionId: string): Promise<void> {
    const existing = await this.get(workspaceId);
    const sameExtension = existing?.extension_id === extensionId;
    await this.write({
      workspace_id: workspaceId,
      extension_id: extensionId,
      conversation_id: sameExtension ? existing.conversation_id : null,
      last_heartbeat_at: sameExtension ? existing.last_heartbeat_at : null,
      recent_fingerprints: sameExtension ? existing.recent_fingerprints : [],
    });
  }

  async recordHeartbeat(
    workspaceId: string,
    extensionId: string,
    conversationId: string | null,
  ): Promise<void> {
    const existing = await this.requireExtension(workspaceId, extensionId);
    await this.write({
      ...existing,
      conversation_id: conversationId ?? existing.conversation_id,
      last_heartbeat_at: new Date().toISOString(),
    });
  }

  async hasFingerprint(workspaceId: string, fingerprint: string): Promise<boolean> {
    const existing = await this.get(workspaceId);
    return existing?.recent_fingerprints.includes(fingerprint) ?? false;
  }

  async recordFingerprint(
    workspaceId: string,
    extensionId: string,
    fingerprint: string,
  ): Promise<void> {
    const existing = await this.requireExtension(workspaceId, extensionId);
    const next = [
      ...existing.recent_fingerprints.filter((value) => value !== fingerprint),
      fingerprint,
    ].slice(-MAX_RECENT_FINGERPRINTS);
    await this.write({ ...existing, recent_fingerprints: next });
  }

  private async requireExtension(
    workspaceId: string,
    extensionId: string,
  ): Promise<RelayStatusState> {
    const existing = await this.get(workspaceId);
    if (!existing || existing.extension_id !== extensionId) {
      throw new Error("RELAY_EXTENSION_MISMATCH");
    }
    return existing;
  }

  private async write(value: RelayStatusState): Promise<void> {
    const validated = RelayStatusStateSchema.parse(value);
    const path = this.path(validated.workspace_id);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, path);
  }
}

export { MAX_RECENT_FINGERPRINTS };
