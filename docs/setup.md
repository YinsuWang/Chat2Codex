# Chat2Codex V1 Setup

Chat2Codex V1 separates two paths:

- **Data plane:** ChatGPT reads workspace state and execution evidence through a read-only MCP bridge.
- **Control plane:** the **Browser Extension Relay** moves small `[CHAT2CODEX]` messages between one explicitly bound ChatGPT Web conversation and the local Supervisor.

Codex CLI remains the only project executor. Codex Desktop IAB is an experimental fallback/recovery transport, not the default path.

## 1. Prerequisites

Install Node.js 20 or newer, Git, pnpm (Corepack is fine), OpenAI Codex CLI, and Chrome/Edge 116+.

Build Chat2Codex:

~~~bash
corepack enable
pnpm install
pnpm build
~~~

For an extension-only rebuild:

~~~bash
pnpm build:extension
~~~

The unpacked extension output is `dist-extension/`. Do not load the `extension/` source directory.

During development you may run commands as `node <chat2codex-checkout>/bin/chat2codex.js ...`. A global link/package install can provide the shorter `chat2codex` command.

## 2. Install the Browser Extension Relay

Chrome:

~~~text
chrome://extensions
~~~

Edge:

~~~text
edge://extensions
~~~

Enable **Developer mode**, choose **Load unpacked**, and select:

~~~text
<chat2codex-checkout>/dist-extension
~~~

The extension is intentionally narrow: ChatGPT Web, extension-local storage/tabs for explicit binding, and loopback HTTP/WebSocket access for local pairing. Do **not** enable remote debugging, dangerous Chrome flags, external browser automation, cookie/history/debugger permissions, or broad host permissions.

See [extension-install.md](extension-install.md) for the focused browser installation checklist.

## 3. Register the target repository

Run against the project ChatGPT/Codex should work on:

~~~bash
chat2codex init <target-repository> --json
~~~

Keep the returned `workspace_id`. Absolute machine paths remain in Chat2Codex's machine-local state and are not written into project control messages.

## 4. Start the Supervisor, MCP bridge, and browser relay

~~~bash
chat2codex start -w <target-repository> --json
~~~

Keep this process running. It owns, under the daemon lock:

- the durable Supervisor loop;
- the Codex CLI execution adapter;
- the read-only MCP bridge on `127.0.0.1`;
- the Browser Extension Relay on `127.0.0.1`.

The JSON startup output reports the bridge and relay ports. The MCP bridge prefers `48765`; the relay prefers `48766`; either may fall back to an ephemeral loopback port if its preferred port is occupied.

## 5. Create a one-time extension pairing code

In a second terminal:

~~~bash
chat2codex relay pair -w <target-repository> --json
~~~

The command returns the workspace ID, short one-time pairing code, expiry, and remaining attempts. It does not print the long-lived relay token.

In the extension popup enter:

1. the relay port from `chat2codex start ... --json` or `chat2codex relay status ... --json`;
2. the exact `workspace_id`;
3. the one-time pairing code.

Choose **Pair**. If the code expires or is exhausted, create a new one; do not reuse an old code.

## 6. Explicitly bind the intended ChatGPT conversation

Open the intended `https://chatgpt.com/...` conversation in the active tab. Open the extension popup and click:

~~~text
Bind current ChatGPT tab
~~~

Binding is explicit:

- a non-`chatgpt.com` tab is rejected;
- one tab binds to at most one workspace;
- one workspace has at most one active bound tab in V1;
- switching to another conversation is not silently treated as the same binding.

Repository files, diffs, logs, command output, and credentials are never transported through the browser relay.

## 7. Check Browser Relay status

~~~bash
chat2codex relay status -w <target-repository> --json
~~~

A ready local relay should show `relay_running: true`, `host: "127.0.0.1"`, `paired: true`, `bound_tab_seen: true`, and a recent `last_heartbeat_at`.

The bound-tab heartbeat is refreshed only when the service worker can verify that the bound ChatGPT content script is still on the same conversation. The Task 10 gate treats heartbeats older than 90 seconds as stale.

## 8. Run the read-only local Browser Relay acceptance gate

First build:

~~~bash
pnpm build
~~~

Then run:

~~~bash
node scripts/acceptance-relay.mjs --workspace <target-repository>
~~~

For machine-readable output:

~~~bash
node scripts/acceptance-relay.mjs --workspace <target-repository> --json
~~~

The script is read-only. It does not start/stop services, pair/unpair, mutate Supervisor/mailbox/task/worktree state, or edit the primary working tree. It checks:

- registered workspace identity;
- live Supervisor daemon;
- healthy loopback MCP bridge;
- live loopback relay server;
- paired extension;
- recent bound-tab heartbeat;
- the exact read-only MCP tool invariant;
- the built unpacked extension artifact and least-privilege manifest;
- that primary working-tree status is unchanged while the checks run.

A failure returns a non-zero exit code. `--help` does not require a prebuilt `dist/`.

## 9. Read-only MCP connection

ChatGPT cannot directly call a localhost MCP server. Complete end-to-end review therefore requires a supported authenticated remote connection to the loopback MCP data plane.

**Task 10 does not implement Remote MCP.** Do not weaken the local listener, expose an unauthenticated public endpoint, or add broad browser permissions to compensate. Browser relay and Remote MCP are independent subsystems.

The bound ChatGPT conversation should follow [protocol.md](protocol.md): verify `workspace_info`, emit bounded PLAN/REVIEW control messages, and review real `git_diff`, `execution_summary`, `test_status`, and readable `execution_output` evidence through MCP.

## 10. Doctor and fallback transports

~~~bash
chat2codex doctor -w <target-repository> --json
~~~

`doctor` currently retains a legacy `desktop_relay_skill` check for the experimental Desktop IAB fallback. Task 10 intentionally does not refactor that behavior. A Browser Relay setup should therefore use `relay status` plus `scripts/acceptance-relay.mjs` as its dedicated acceptance gate.

If the Browser Extension Relay is unavailable, the retained Desktop IAB Skill or the manual `chat2codex control ...` commands may be used for recovery. They are not Browser Relay acceptance prerequisites.

## 11. Unpair

~~~bash
chat2codex relay unpair -w <target-repository> --json
~~~

Then explicitly pair and bind again if needed.

## 12. What CI proves—and does not prove

CI runs Node 20 and Node 22 verification, builds `dist-extension/`, asserts the required extension files exist, and uploads the Node 22 built directory as `chat2codex-extension-unpacked`.

CI does **not** prove a real authenticated ChatGPT Web session, a real browser tab binding, or a complete remote MCP path. Those remain final real-machine acceptance requirements before declaring Complete V1.
