import { Command } from "commander";

import { ControlService } from "../../control/service.js";
import { MAX_CONTROL_TEXT_BYTES } from "../../protocol/text-format.js";

async function readBoundedStdin(maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.byteLength;
    if (total > maxBytes) throw new Error(`Control message exceeds ${maxBytes} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function createControlCommand(): Command {
  const command = new Command("control").description("Manage the durable Chat2Codex control mailbox");

  command
    .command("ingest")
    .requiredOption("-w, --workspace <id>", "workspace id")
    .option("--stdin", "read one [CHAT2CODEX] control message from stdin")
    .action(async (options: { workspace: string; stdin?: boolean }) => {
      if (!options.stdin) throw new Error("control ingest requires --stdin");
      const text = await readBoundedStdin(MAX_CONTROL_TEXT_BYTES);
      const envelope = await new ControlService(options.workspace).ingest(text);
      process.stdout.write(`${JSON.stringify({ message: envelope })}\n`);
    });

  command
    .command("next")
    .requiredOption("-w, --workspace <id>", "workspace id")
    .option("--json", "emit JSON", true)
    .action(async (options: { workspace: string }) => {
      const envelope = await new ControlService(options.workspace).next(options.workspace);
      process.stdout.write(`${JSON.stringify({ message: envelope })}\n`);
    });

  command
    .command("ack")
    .requiredOption("-w, --workspace <id>", "workspace id")
    .requiredOption("--id <id>", "envelope id")
    .action(async (options: { workspace: string; id: string }) => {
      await new ControlService(options.workspace).acknowledgeOutbound(options.id);
      process.stdout.write(`${JSON.stringify({ acked: options.id })}\n`);
    });

  return command;
}
