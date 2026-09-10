import { Command } from "commander";

import type { WorkspaceRecord } from "../../config/types.js";
import { registerWorkspace } from "../../workspace/registry.js";

function publicWorkspaceRecord(record: WorkspaceRecord): WorkspaceRecord {
  return {
    ...record,
    git_remote: record.git_remote,
  };
}

export function createInitCommand(): Command {
  return new Command("init")
    .description("Register a local Git workspace with Chat2Codex")
    .argument("[path]", "workspace path", process.cwd())
    .option("--json", "print machine-readable JSON")
    .action(async (path: string, options: { json?: boolean }) => {
      const record = publicWorkspaceRecord(await registerWorkspace(path));
      if (options.json) {
        process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
        return;
      }

      process.stdout.write(`Registered ${record.workspace_name}\n`);
      process.stdout.write(`workspace_id: ${record.workspace_id}\n`);
      process.stdout.write(`root: ${record.root}\n`);
    });
}
