# Chat2Codex V1 Setup

Chat2Codex V1 separates two paths:

- **Data plane:** ChatGPT reads the local workspace and execution evidence through a read-only MCP bridge.
- **Control plane:** Codex Desktop's in-app-browser relay moves small `[CHAT2CODEX]` messages between ChatGPT and the local Supervisor.

Codex CLI remains the only project executor.

## 1. Prerequisites

Install:

- Node.js 20 or newer
- Git
- pnpm (Corepack is fine)
- OpenAI Codex CLI
- Codex Desktop for the V1 automatic ChatGPT UI relay

Then build Chat2Codex:

```bash
corepack enable
pnpm install
pnpm build
```

During development you may run commands as `node <chat2codex-checkout>/bin/chat2codex.js ...`. A global link/package install can provide the shorter `chat2codex` command.

## 2. Register the target repository

Run this inside the project ChatGPT/Codex should work on, not inside the Chat2Codex source repository:

```bash
chat2codex init . --json
```

Keep the returned `workspace_id`. Absolute machine paths stay in the local Chat2Codex state directory and are not committed to the target repository.

## 3. Install the Desktop relay Skill

Install `skill/SKILL.md` as `chat2codex-relay/SKILL.md` in a Codex-recognized Skill directory. Common locations are:

```text
~/.codex/skills/chat2codex-relay/SKILL.md
~/.agents/skills/chat2codex-relay/SKILL.md
```

On Windows, `~` is your user profile directory.

## 4. Start the local Supervisor and MCP bridge

```bash
chat2codex start -w <target-repository> --json
```

The command starts:

- the durable Supervisor loop,
- the Codex CLI execution adapter,
- a read-only MCP server bound only to `127.0.0.1`.

The bridge prefers port `48765` and falls back to an ephemeral loopback port if it is occupied. `chat2codex status -w <target-repository> --json` reports the active local port.

## 5. Connect ChatGPT to the read-only MCP bridge

ChatGPT does not connect directly to localhost MCP servers. Use a supported authenticated remote-connection path for your ChatGPT account/environment.

Preferred where available:

- OpenAI Secure MCP Tunnel for a private/local MCP server.

Compatibility path:

- the same read-only remote-connector/tunnel pattern already proven by `codex-with-chatgpt`, pointed at Chat2Codex's MCP endpoint through an authenticated transport.

Chat2Codex V1 intentionally does **not** expose an unauthenticated public listener and does not hard-code Cloudflare, a domain, a VPS, or router port forwarding into the Supervisor. The core bridge remains loopback-only; remote authentication/tunneling is a replaceable boundary.

If your ChatGPT plan/workspace UI does not offer a supported custom read-only MCP connection, the local execution pieces still work, but the fully automatic ChatGPT data-plane loop cannot be considered configured yet.

## 6. Bind one ChatGPT chat/project to the workspace

Use `docs/protocol.md` as the boot contract. The bound ChatGPT conversation must:

1. use only the connector for this workspace,
2. call `workspace_info` before planning,
3. verify the expected `workspace_id`,
4. default to `guided` mode,
5. review real diff/execution evidence after `EXECUTED`.

Do not upload the repository into the ChatGPT Project as a substitute for MCP.

## 7. Start the Codex Desktop relay

Load the `chat2codex-relay` Skill in Codex Desktop. It must use the built-in in-app browser, one ChatGPT tab, and the local commands:

```bash
chat2codex status -w <target-repository> --json
chat2codex control next --workspace <workspace_id> --json
chat2codex control ingest --workspace <workspace_id> --stdin
chat2codex control ack --workspace <workspace_id> --id <envelope_id>
```

The relay carries control messages only. Repository files, diffs, and logs remain on the MCP data plane.

## 8. Run doctor

```bash
chat2codex doctor -w <target-repository> --json
```

A ready automatic V1 setup should report healthy prerequisites, a registered Git workspace, a live bridge/daemon, the read-only tool registry, and the installed Desktop relay Skill.

## 9. Acceptance check

In the bound ChatGPT Chat, request a small code change. Expected sequence:

```text
user request
→ workspace_info verification
→ PLAN (guided by default)
→ Supervisor inbox
→ isolated Git worktree
→ codex exec --json
→ persisted execution evidence
→ EXECUTED
→ ChatGPT reads diff/test evidence through MCP
→ REVIEW/PASS or REVIEW/REVISE
→ DONE after PASS
```

The primary project working tree must remain unchanged by the automatic task.

## V1 limitations

- The automatic UI relay requires Codex Desktop. A CLI-only automatic ChatGPT relay needs a future `ControlTransport`.
- Chat2Codex's own bridge is loopback-only; remote authenticated MCP connectivity is deliberately delegated to Secure MCP Tunnel or another compatible transport.
- V1 does not auto-push, auto-merge, or silently remove reviewed worktrees.
- ChatGPT never receives project shell/write/delete/commit/push tools from Chat2Codex.
