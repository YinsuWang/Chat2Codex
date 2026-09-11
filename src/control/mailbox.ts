import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { getStateDir } from "../config/paths.js";
import { parseControlMessage } from "../protocol/schemas.js";
import type { ControlMessage } from "../protocol/types.js";
import type { ControlEnvelope, ControlTransport } from "./transport.js";

export type MailboxQueue = "inbox" | "outbox";

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}: ${value}`);
  }
}

async function ensureDirs(root: string): Promise<void> {
  await Promise.all([
    mkdir(join(root, "inbox"), { recursive: true }),
    mkdir(join(root, "outbox"), { recursive: true }),
    mkdir(join(root, "acked"), { recursive: true }),
  ]);
}

async function nextEpochMilliseconds(queueDir: string): Promise<number> {
  const names = await readdir(queueDir).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  let latest = 0;
  for (const name of names) {
    const match = /^(\d{13})-/.exec(name);
    if (match) latest = Math.max(latest, Number(match[1]));
  }
  return Math.max(Date.now(), latest + 1);
}

export class MailboxTransport implements ControlTransport {
  private readonly root: string;

  constructor(
    private readonly workspaceId: string,
    private readonly queue: MailboxQueue,
    stateDir = getStateDir(),
  ) {
    assertSafeId(workspaceId, "workspace_id");
    this.root = join(stateDir, "control", workspaceId);
  }

  private queueDir(): string {
    return join(this.root, this.queue);
  }

  async publish(message: ControlMessage): Promise<ControlEnvelope> {
    if (message.workspace_id !== this.workspaceId) {
      throw new Error(`WORKSPACE_MISMATCH: ${message.workspace_id} != ${this.workspaceId}`);
    }
    await ensureDirs(this.root);
    const epoch = await nextEpochMilliseconds(this.queueDir());
    const id = `${String(epoch).padStart(13, "0")}-${randomBytes(8).toString("hex")}`;
    const envelope: ControlEnvelope = { id, created_at: new Date().toISOString(), message };
    const finalPath = join(this.queueDir(), `${id}.json`);
    const temporary = `${finalPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(envelope)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, finalPath);
    return envelope;
  }

  async receive(): Promise<ControlEnvelope | null> {
    await ensureDirs(this.root);
    const names = (await readdir(this.queueDir()))
      .filter((name) => /^\d{13}-[a-f0-9]{16}\.json$/.test(name))
      .sort();
    const first = names[0];
    if (!first) return null;
    const raw = JSON.parse(await readFile(join(this.queueDir(), first), "utf8")) as Partial<ControlEnvelope>;
    if (typeof raw.id !== "string" || typeof raw.created_at !== "string" || raw.message === undefined) {
      throw new Error(`MAILBOX_ENVELOPE_MISMATCH: ${first}`);
    }
    const envelope: ControlEnvelope = {
      id: raw.id,
      created_at: raw.created_at,
      message: parseControlMessage(raw.message),
    };
    if (envelope.message.workspace_id !== this.workspaceId || `${envelope.id}.json` !== first) {
      throw new Error(`MAILBOX_ENVELOPE_MISMATCH: ${first}`);
    }
    return envelope;
  }

  async acknowledge(id: string): Promise<void> {
    assertSafeId(id, "envelope_id");
    await ensureDirs(this.root);
    const source = join(this.queueDir(), `${id}.json`);
    const destination = join(this.root, "acked", `${this.queue}-${id}.json`);
    try {
      await rename(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`ENVELOPE_NOT_FOUND: ${id}`);
      }
      throw error;
    }
  }
}
