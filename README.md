# Chat2Codex

**ChatGPT plans and reviews. Codex executes. Chat2Codex keeps them bound to the same local task and workspace.**

Chat2Codex is a local-first orchestration layer for using ChatGPT Chat as the project understanding, code-design, and independent review surface while keeping filesystem writes, shell commands, Git operations, builds, and tests in Codex CLI.

## Architecture

```text
┌──────────────────────────────────────────┐
│              ChatGPT Chat                │
│  understand · plan · code-design · review│
└──────────────┬───────────────▲───────────┘
               │               │
       read-only MCP       UI control relay
               │        (Codex Desktop IAB)
               ▼               │
┌──────────────────────────────────────────┐
│          Chat2Codex Supervisor           │
│ workspace binding · task state · mailbox │
│ worktrees · execution evidence · policy  │
└──────────────────┬───────────────────────┘
                   │ codex exec --json
                   ▼
               Codex CLI
                   │
          write · shell · git · test
                   ▼
           isolated Git worktree
```

The Supervisor is deterministic local orchestration, not another AI model.

## V1 workflow

```text
User asks ChatGPT for a code change
→ ChatGPT verifies workspace_info
→ ChatGPT emits PLAN
→ Supervisor validates workspace/base
→ isolated task worktree
→ Codex CLI executes locally
→ execution evidence is persisted/sanitized
→ Supervisor emits EXECUTED
→ ChatGPT reads the real diff/test evidence through MCP
→ REVIEW/PASS or REVIEW/REVISE
→ another Codex iteration or DONE
```

`EXECUTED` means an execution attempt finished. Only review can approve it.

## Three implementation modes

- **`guided` (default):** ChatGPT supplies concrete implementation guidance and key code-level decisions; Codex adapts it to the live local repository and verifies it.
- **`delegate`:** ChatGPT supplies architecture/intent; Codex performs more local implementation discovery. Best for broad refactors.
- **`patch`:** ChatGPT supplies a small complete/near-complete patch pinned to a known base. Stale bases are rejected before execution.

After a `patch` task receives `REVIEW/REVISE`, the next iteration switches to `guided` rather than blindly reapplying the old patch.

## Security boundary

ChatGPT's Chat2Codex MCP surface is read-only. V1 exposes:

```text
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
```

It does **not** expose project write, shell, delete, commit, push, or patch-application tools.

Additional protections include:

- canonical workspace containment and symlink-escape rejection,
- hard denial of `.env`, SSH/private-key/cloud-credential paths (`.env.example` remains readable),
- `.chat2codexignore` for extra local exclusions,
- sanitized execution output with private-key bodies withheld entirely,
- explicit immutable workspace identity,
- Git worktree isolation,
- stale-base guards for code-level guidance/patches,
- durable task/mailbox state across process restarts,
- loopback-only MCP listener (`127.0.0.1`).

## Quick start

See **[docs/setup.md](docs/setup.md)** for the complete V1 setup.

At a high level:

```bash
corepack enable
pnpm install
pnpm build

# in the target repository
chat2codex init . --json
chat2codex start -w . --json
```

Install `skill/SKILL.md` as the Codex Desktop `chat2codex-relay` Skill, connect ChatGPT to the read-only MCP data plane through a supported authenticated remote transport, bind one chat/project to the returned workspace ID, and run:

```bash
chat2codex doctor -w . --json
```

ChatGPT cannot directly call a localhost MCP server. The core Chat2Codex bridge deliberately remains loopback-only; use OpenAI Secure MCP Tunnel where supported or another compatible authenticated read-only connector/tunnel path. Chat2Codex does not require an owned domain, public IP, router forwarding, or VPS in its core architecture.

## Control protocol

UI control messages are bounded and start with:

```text
[CHAT2CODEX]
```

They contain task state/instructions only. Repository files, diffs, and logs stay on the read-only MCP data plane. See **[docs/protocol.md](docs/protocol.md)**.

## Commands

```text
chat2codex init
chat2codex start
chat2codex status
chat2codex doctor
chat2codex control ingest
chat2codex control next
chat2codex control ack
```

## V1 limitations

- Automatic ChatGPT UI relay requires **Codex Desktop** even though **Codex CLI** is the execution backend.
- A CLI-only automatic ChatGPT relay is a future `ControlTransport`.
- The built-in MCP server is loopback-only; authenticated remote tunneling/connector provisioning remains a replaceable deployment boundary rather than part of the Supervisor.
- V1 does not auto-push or auto-merge.
- Reviewed task worktrees are retained by default for inspection/integration.
- A real Desktop/ChatGPT acceptance run requires a machine with the user's ChatGPT session, Codex Desktop, Codex CLI, and configured read-only MCP connection; CI can validate the deterministic local components but cannot manufacture that session.

## Development

```bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
```

CI runs the verification suite on Node 20 and Node 22. A failing CI run is a release blocker.

For common recovery cases, see **[docs/troubleshooting.md](docs/troubleshooting.md)**.

## Design documents

The approved architecture and implementation plan live under:

```text
docs/superpowers/specs/
docs/superpowers/plans/
```
