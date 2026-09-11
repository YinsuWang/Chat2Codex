import { Command } from "commander";

import { createControlCommand } from "./commands/control.js";
import { createDoctorCommand } from "./commands/doctor.js";
import { createInitCommand } from "./commands/init.js";
import { createStartCommand } from "./commands/start.js";
import { createStatusCommand } from "./commands/status.js";

const program = new Command()
  .name("chat2codex")
  .description("ChatGPT plans and reviews; Codex executes locally.")
  .version("0.1.0");

program.addCommand(createInitCommand());
program.addCommand(createControlCommand());
program.addCommand(createStartCommand());
program.addCommand(createStatusCommand());
program.addCommand(createDoctorCommand());

await program.parseAsync(process.argv);
