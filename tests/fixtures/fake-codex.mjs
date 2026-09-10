const args = process.argv.slice(2);
if (args[0] !== "exec" || args[1] !== "--json") process.exit(64);
if (process.env.FAKE_CODEX_HANG === "1") {
  process.stdout.write(JSON.stringify({ type: "thread.started", cwd: process.cwd() }) + "\n");
  setInterval(() => undefined, 1_000);
} else {
  process.stdout.write(JSON.stringify({ type: "thread.started", cwd: process.cwd() }) + "\n");
  process.stdout.write('{"type":"turn.completed","ok":true}');
  process.stderr.write("fake stderr");
  process.exit(Number(process.env.FAKE_CODEX_EXIT ?? 0));
}
