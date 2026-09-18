# Browser Extension Relay Installation

The Browser Extension Relay is the default automatic Chat2Codex V1 control transport. This document covers Chrome/Edge installation and local pairing only. Codex Desktop IAB is an experimental fallback/recovery path.

## Build the unpacked extension

From the Chat2Codex checkout:

~~~bash
pnpm build:extension
~~~

The command cleans and recreates `dist-extension/`.

A valid build contains at least:

~~~text
manifest.json
service-worker.js
content-script.js
popup.js
popup.html
~~~

Load `dist-extension/`, not the TypeScript source under `extension/`.

## Chrome

Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select:

~~~text
<chat2codex-checkout>/dist-extension
~~~

## Microsoft Edge

Open `edge://extensions`, enable **Developer mode**, click **Load unpacked**, and select the same `dist-extension/` directory.

No remote-debugging switch, dangerous browser flag, external browser automation, cookie/history/debugger permission, or broad `https://*/*` permission is required.

## Start the local relay

Keep the local runtime running:

~~~bash
chat2codex start -w <workspace> --json
~~~

Record the returned `relay_port`. In another terminal create a one-time pairing code:

~~~bash
chat2codex relay pair -w <workspace> --json
~~~

The CLI prints the workspace ID and one-time code but never the long-lived relay token.

## Pair the extension

Open the extension popup and enter:

- **Relay port** — from `start --json` or `relay status --json`;
- **Workspace ID** — the exact registered `ws_...` identifier;
- **One-time pairing code** — the current unexpired code.

Click **Pair**. Generate a new code if the old one expired, was exhausted, or was already consumed.

## Bind the current ChatGPT tab

Open the intended `https://chatgpt.com/...` conversation, then open the extension popup and click:

~~~text
Bind current ChatGPT tab
~~~

The extension rejects non-`chatgpt.com` tabs. It stores the binding locally and does not send repository files, diffs, logs, or credentials through the relay.

## Verify local status

~~~bash
chat2codex relay status -w <workspace> --json
node scripts/acceptance-relay.mjs --workspace <workspace>
~~~

A healthy local gate requires a live loopback relay, paired authorization, a recently observed heartbeat from the bound ChatGPT conversation, the unchanged read-only MCP tool registry, and a valid `dist-extension/` build. Heartbeats older than 90 seconds are treated as stale.

For JSON automation:

~~~bash
node scripts/acceptance-relay.mjs --workspace <workspace> --json
~~~

This local gate does not automate ChatGPT Web and is not evidence that the final real-machine end-to-end acceptance has passed.

## Unbind or unpair

Use **Unbind** in the popup to remove the current tab binding without revoking pairing.

Use the CLI to revoke the workspace authorization:

~~~bash
chat2codex relay unpair -w <workspace> --json
~~~

Then explicitly pair and bind again if needed.

See [troubleshooting.md](troubleshooting.md) for stale heartbeat, browser restart, lost-tab, UI compatibility, and artifact-loading recovery.
