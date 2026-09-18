# Chat2Codex

**ChatGPT plans and reviews. Codex executes. Chat2Codex keeps them bound to the same local task and workspace.**

Chat2Codex is a local-first orchestration layer for using ChatGPT Chat as the project-understanding, code-design, and independent-review surface while keeping filesystem writes, shell commands, Git operations, builds, and tests in Codex CLI.

## Architecture

~~~text
┌──────────────────────────────────────────┐
│              ChatGPT Chat                │
│  understand · plan · code-design · review│
└──────────────┬───────────────▲───────────┘
               │               │
       read-only MCP      control messages
               │               │
               ▼               │
┌──────────────────────────────────────────┐
│          Chat2Codex Supervisor           │
│ workspace · task · mailbox · evidence    │
└──────────────┬───────────────▲───────────┘
               │               │
       codex exec --json    loopback relay
               ▼               │
            Codex CLI           │
               │          Browser Extension
       write · shell · git      │
               ▼               │
      isolated Git worktree    ChatGPT Web
~~~

The Supervisor is deterministic local orchestration, not another AI model. The **Browser Extension Relay is the default automatic V1 control transport**. Codex Desktop IAB remains an experimental fallback/recovery transport; manual CLI relay remains a development/recovery fallback.

## V1 workflow

~~~text
User asks ChatGPT for a code change
→ ChatGPT verifies workspace_info
→ ChatGPT emits PLAN
→ Browser Extension Relay ingests the bounded control message
→ Supervisor validates workspace/base
→ isolated task worktree
→ Codex CLI executes locally
→ execution evidence is persisted/sanitized
→ Supervisor emits EXECUTED
→ Browser Extension Relay delivers it to the bound ChatGPT conversation
→ ChatGPT reads the real diff/test evidence through read-only MCP
→ REVIEW/PASS or REVIEW/REVISE
→ another Codex iteration or DONE
~~~

`EXECUTED` means an execution attempt finished. Only review can approve it.

## Three implementation modes

- **`guided` (default):** ChatGPT supplies concrete implementation guidance and key code-level decisions; Codex adapts it to the live local repository and verifies it.
- **`delegate`:** ChatGPT supplies architecture/intent; Codex performs more local implementation discovery. Best for broad refactors.
- **`patch`:** ChatGPT supplies a small complete/near-complete patch pinned to a known base. Stale bases are rejected before execution.

After a `patch` task receives `REVIEW/REVISE`, the next iteration switches to `guided` rather than blindly reapplying the old patch.

## Security boundary

ChatGPT's Chat2Codex MCP surface is read-only. V1 exposes exactly:

~~~text
workspace_info
list_directory
read_file
search_workspace
git_status
git_diff
task_get
task_list
task_history
execution_summary
execution_output
test_status
~~~

It does **not** expose project write, shell, delete, commit, push, install, or patch-application tools.

The Browser Extension Relay is a separate bounded control plane. It carries `[CHAT2CODEX]` protocol messages only; repository files, diffs, logs, command output, cookies, and credentials do not travel through relay frames. The relay binds only to `127.0.0.1`, pairing is workspace-bound, and the extension is limited to `chatgpt.com` plus loopback access required for local pairing.

Additional protections include canonical workspace containment, sensitive-path denial, sanitized execution output, immutable workspace identity, Git worktree isolation, stale-base guards, durable mailbox state, and no automatic push/merge.

## Quick start

See **[docs/setup.md](docs/setup.md)** for the complete setup and **[docs/extension-install.md](docs/extension-install.md)** for the browser-only installation flow.

Build Chat2Codex and the unpacked extension:

~~~bash
corepack enable
pnpm install
pnpm build
# extension-only rebuilds may use:
pnpm build:extension
~~~

The Chrome/Edge **Load unpacked** directory is `dist-extension/`.

Register and start the target workspace:

~~~bash
chat2codex init <target-repository> --json
chat2codex start -w <target-repository> --json
~~~

Keep `start` running. In another terminal create a one-time pairing code:

~~~bash
chat2codex relay pair -w <target-repository> --json
~~~

Enter the reported workspace ID and pairing code, plus the relay port reported by `start --json` or `relay status --json`, in the extension popup. Open the intended `https://chatgpt.com/...` conversation and click **Bind current ChatGPT tab**.

Then inspect relay status and run the read-only local acceptance gate:

~~~bash
chat2codex relay status -w <target-repository> --json
node scripts/acceptance-relay.mjs --workspace <target-repository>
~~~

The acceptance script requires a built project but `--help` does not:

~~~bash
node scripts/acceptance-relay.mjs --help
~~~

ChatGPT cannot directly call a localhost MCP server. The local MCP bridge deliberately remains loopback-only; complete end-to-end ChatGPT review therefore also requires a supported authenticated read-only MCP connection path. Browser-relay Task 10 does not implement Remote MCP and the local acceptance script does not claim to validate a real `chatgpt.com` session.

## Control transports

- **Browser Extension Relay — default automatic V1 control transport.**
- **Desktop IAB Skill — experimental fallback/recovery only.**
- **Manual CLI relay — development/recovery fallback.**

The Desktop IAB Skill is retained in `skill/SKILL.md`, but it is not a Browser Extension Relay acceptance prerequisite.

## Commands

~~~text
chat2codex init
chat2codex start
chat2codex status
chat2codex doctor
chat2codex relay pair
chat2codex relay status
chat2codex relay unpair
chat2codex control ingest
chat2codex control next
chat2codex control ack
~~~

`chat2codex doctor` currently retains a legacy check for the Desktop IAB fallback Skill. For the default Browser Extension Relay, use `relay status` plus `scripts/acceptance-relay.mjs` as the dedicated local acceptance gate.

## V1 status and limitations

- Browser Extension Relay is the default automatic control transport; Codex Desktop is not required for that path.
- The built-in MCP bridge remains loopback-only.
- Remote MCP implementation is intentionally outside Task 10.
- CI validates deterministic local components and an installable unpacked extension artifact; it does **not** perform a real authenticated `chatgpt.com` acceptance run.
- V1 does not auto-push or auto-merge.
- Reviewed task worktrees are retained by default for inspection/integration.
- **Complete V1 must not be declared until the final real-machine Browser Relay + read-only MCP acceptance gate passes.**

## Development

~~~bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
node scripts/acceptance-relay.mjs --help
~~~

CI runs the verification suite on Node 20 and Node 22, verifies the built extension files, and uploads one `chat2codex-extension-unpacked` artifact from the Node 22 job. A red CI run is a release blocker.

For common recovery cases, see **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Design documents

The approved architecture and implementation plan live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
