import { Command } from "commander";

import { createInitCommand } from "./commands/init.js";

const program = new Command()
  .name("chat2codex")
  .description("ChatGPT plans and reviews; Codex executes locally.")
  .version("0.1.0");

program.addCommand(createInitCommand());

await program.parseAsync(process.argv);
