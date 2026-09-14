const args = process.argv.slice(2);
const expectedPrefix = [
  "--ask-for-approval",
  "never",
  "exec",
  "--json",
  "--sandbox",
  "workspace-write",
];
if (expectedPrefix.some((value, index) => args[index] !== value)) {
  process.stderr.write(`unexpected args: ${JSON.stringify(args)}\n`);
  process.exit(64);
}
if (typeof args[expectedPrefix.length] !== "string" || args[expectedPrefix.length].length === 0) {
  process.stderr.write("missing prompt\n");
  process.exit(64);
}
if (process.env.FAKE_CODEX_HANG === "1") {
  process.stdout.write(JSON.stringify({ type: "thread.started", cwd: process.cwd() }) + "\n");
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", cwd: process.cwd() }) + "\n");
  process.stdout.write('{"type":"turn.completed","ok":true}');
  process.stderr.write("fake stderr");
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}
