import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getStateDir } from "../config/paths.js";
import { sanitizeOutput } from "./sanitizer.js";
import type {
  ExecutionFinishInput,
  ExecutionIterationStart,
  ExecutionOutputEntry,
  ExecutionSummary,
} from "./types.js";

function assertSafeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`INVALID_${label.toUpperCase()}: ${value}`);
  }
}

function assertIteration(iteration: number): void {
  if (!Number.isSafeInteger(iteration) || iteration < 0) {
    throw new Error(`INVALID_ITERATION: ${iteration}`);
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  const handle = await open(temporary, "w", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function appendSynced(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "a", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class ExecutionRecorder {
  private readonly stateDir: string;

  constructor(stateDir = getStateDir()) {
    this.stateDir = stateDir;
  }

  private iterationDir(taskId: string, iteration: number): string {
    assertSafeId(taskId, "task_id");
    assertIteration(iteration);
    return join(this.stateDir, "tasks", taskId, "iterations", String(iteration).padStart(3, "0"));
  }

  private outputsIndexPath(taskId: string, iteration: number): string {
    return join(this.iterationDir(taskId, iteration), "outputs", "index.json");
  }

  async startIteration(input: ExecutionIterationStart): Promise<ExecutionSummary> {
    const dir = this.iterationDir(input.task_id, input.iteration);
    await mkdir(join(dir, "outputs"), { recursive: true });
    await atomicWriteJson(join(dir, "control-message.json"), input.control_message);
    await writeFile(join(dir, "codex-events.jsonl"), "", { encoding: "utf8", mode: 0o600 });
    await atomicWriteJson(this.outputsIndexPath(input.task_id, input.iteration), []);
    const summary: ExecutionSummary = {
      task_id: input.task_id,
      iteration: input.iteration,
      status: "running",
      started_at: new Date().toISOString(),
      changed_files: [],
      tests_summary: "",
    };
    await atomicWriteJson(join(dir, "execution-summary.json"), summary);
    return summary;
  }

  async appendCodexEvent(taskId: string, iteration: number, event: unknown): Promise<void> {
    await appendSynced(
      join(this.iterationDir(taskId, iteration), "codex-events.jsonl"),
      `${JSON.stringify(event)}\n`,
    );
  }

  async recordCommandOutput(
    taskId: string,
    iteration: number,
    label: string,
    body: string,
  ): Promise<ExecutionOutputEntry> {
    if (label.trim().length === 0) throw new Error("INVALID_OUTPUT_LABEL");
    const sanitized = sanitizeOutput(body);
    const entry: ExecutionOutputEntry = {
      id: `output_${randomBytes(8).toString("hex")}`,
      label,
      created_at: new Date().toISOString(),
      status: sanitized.status,
      redactions: sanitized.redactions,
      truncated: sanitized.truncated,
    };

    const index = await this.listOutputs(taskId, iteration);
    index.push(entry);
    if (sanitized.status === "readable") {
      const outputPath = join(this.iterationDir(taskId, iteration), "outputs", `${entry.id}.txt`);
      await writeFile(outputPath, sanitized.body ?? "", { encoding: "utf8", mode: 0o600 });
    }
    await atomicWriteJson(this.outputsIndexPath(taskId, iteration), index);
    return entry;
  }

  async finishIteration(
    taskId: string,
    iteration: number,
    input: ExecutionFinishInput,
  ): Promise<ExecutionSummary> {
    const current = await this.getSummary(taskId, iteration);
    const summary: ExecutionSummary = {
      ...current,
      status: "completed",
      ended_at: new Date().toISOString(),
      exit_code: input.exit_code,
      changed_files: [...input.changed_files],
      tests_summary: input.tests_summary,
    };
    const dir = this.iterationDir(taskId, iteration);
    await atomicWriteJson(join(dir, "changed-files.json"), input.changed_files);
    await atomicWriteJson(join(dir, "execution-summary.json"), summary);
    return summary;
  }

  async getSummary(taskId: string, iteration: number): Promise<ExecutionSummary> {
    return JSON.parse(
      await readFile(join(this.iterationDir(taskId, iteration), "execution-summary.json"), "utf8"),
    ) as ExecutionSummary;
  }

  async listOutputs(taskId: string, iteration: number): Promise<ExecutionOutputEntry[]> {
    try {
      return JSON.parse(await readFile(this.outputsIndexPath(taskId, iteration), "utf8")) as ExecutionOutputEntry[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }

  async readOutput(
    taskId: string,
    iteration: number,
    outputId: string,
  ): Promise<ExecutionOutputEntry & { body?: string }> {
    assertSafeId(outputId, "output_id");
    const entry = (await this.listOutputs(taskId, iteration)).find((item) => item.id === outputId);
    if (!entry) throw new Error(`OUTPUT_NOT_FOUND: ${outputId}`);
    if (entry.status === "restricted") return entry;
    const body = await readFile(
      join(this.iterationDir(taskId, iteration), "outputs", `${outputId}.txt`),
      "utf8",
    );
    return { ...entry, body };
  }
}
