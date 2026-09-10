import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";

import type { CodexAdapter, CodexRunHandle, CodexRunInput, CodexRunResult } from "./adapter.js";
import { JsonlDecoder } from "./jsonl.js";
import { buildCodexPrompt } from "./prompt.js";

const MAX_STDERR_BYTES = 256 * 1024;

export class CodexCLIAdapter implements CodexAdapter {
  private readonly processes = new Map<string, ChildProcess>();
  private readonly command: string;
  private readonly prefixArgs: string[];

  constructor(command = process.env.CHAT2CODEX_CODEX_BIN ?? "codex", prefixArgs: string[] = []) {
    this.command = command;
    this.prefixArgs = [...prefixArgs];
  }

  async start(input: CodexRunInput): Promise<CodexRunHandle> {
    const prompt = buildCodexPrompt(input);
    const executionId = `codex_${randomBytes(8).toString("hex")}`;
    const child = spawn(this.command, [...this.prefixArgs, "exec", "--json", prompt], {
      cwd: input.worktree_path,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.processes.set(executionId, child);

    const decoder = new JsonlDecoder();
    let stderr = "";
    let eventChain = Promise.resolve();
    const deliver = (events: ReturnType<JsonlDecoder["feed"]>) => {
      if (!input.onEvent) return;
      for (const event of events) {
        eventChain = eventChain.then(() => input.onEvent?.(event)).then(() => undefined);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => deliver(decoder.feed(chunk)));
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      const remaining = MAX_STDERR_BYTES - Buffer.byteLength(stderr, "utf8");
      if (remaining > 0) stderr += Buffer.from(text, "utf8").subarray(0, remaining).toString("utf8");
      if (input.onStderr) eventChain = eventChain.then(() => input.onStderr?.(text)).then(() => undefined);
    });

    const completion = new Promise<CodexRunResult>((resolve) => {
      let spawnError: Error | undefined;
      child.once("error", (error) => { spawnError = error; });
      child.once("close", (code, signal) => {
        deliver(decoder.end());
        eventChain
          .catch(() => undefined)
          .then(() => {
            this.processes.delete(executionId);
            const result: CodexRunResult = {
              execution_id: executionId,
              pid: child.pid ?? null,
              exit_code: code ?? -1,
              signal,
              stderr,
            };
            if (spawnError) result.spawn_error = spawnError.message;
            resolve(result);
          });
      });
    });

    return { execution_id: executionId, pid: child.pid ?? null, completion };
  }

  async cancel(executionId: string): Promise<void> {
    const child = this.processes.get(executionId);
    if (!child) return;
    child.kill("SIGTERM");
  }
}
