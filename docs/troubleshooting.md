# Chat2Codex Troubleshooting

For the default Browser Extension Relay, start with:

~~~bash
chat2codex relay status -w <target-repository> --json
node scripts/acceptance-relay.mjs --workspace <target-repository> --json
~~~

`chat2codex doctor` remains useful for Core diagnostics, but it currently retains a legacy `desktop_relay_skill` check for the experimental Desktop IAB fallback. Task 10 intentionally leaves that check unchanged.

Do not repair a workspace by deleting state or worktrees blindly. Chat2Codex intentionally persists task identity, mailbox state, and evidence across restarts.

## Relay server not running

Symptoms: `relay status` reports `relay_running: false`, or the acceptance gate fails `relay_server`.

1. Ensure `chat2codex start -w <target-repository> --json` is still running.
2. Confirm the reported relay host is `127.0.0.1`.
3. Restart the normal `chat2codex start` process if the owning daemon exited.
4. Do not expose the relay publicly or substitute remote-debugging/browser-automation flags.

## Extension not paired

Symptoms: `paired: false` or `relay_paired` fails.

Create a fresh one-time code:

~~~bash
chat2codex relay pair -w <target-repository> --json
~~~

Enter the relay port, exact workspace ID, and code in the popup. The long-lived relay token is stored only in extension-local storage and is not printed by the CLI or acceptance script.

## One-time pairing code expired or exhausted

Pairing codes have a short lifetime, limited attempts, and are consumed after successful exchange.

Generate a new code with `chat2codex relay pair ...`. Do not recover or reuse an expired, exhausted, or already-used code.

## No bound ChatGPT tab

Symptoms: `bound_tab_seen: false` or the acceptance gate reports no bound-tab heartbeat.

Open the intended `https://chatgpt.com/...` conversation and explicitly click **Bind current ChatGPT tab** in the extension popup.

## Stale bound-tab heartbeat

The Task 10 local gate treats a bound-tab heartbeat older than 90 seconds as stale.

A generic service-worker WebSocket keepalive does not count as proof that the ChatGPT tab is alive. The extension periodically verifies the bound tab and current conversation before refreshing the tab heartbeat.

If the heartbeat is stale:

1. confirm the bound ChatGPT tab still exists;
2. confirm it is still on the same conversation;
3. reload the ChatGPT tab or extension if needed;
4. explicitly re-bind the intended tab;
5. rerun `relay status` and the acceptance script.

Do not create a new Supervisor task just because the browser disappeared.

## Non-chatgpt.com tab is rejected

This is intentional. The popup only binds an active HTTPS `chatgpt.com` tab. Do not add broad host permissions to work around the restriction.

## `RELAY_UI_UNSUPPORTED`

The ChatGPT Web DOM is not a stable public API. If the adapter cannot identify one unambiguous composer and send action, it must fail closed rather than guess a selector.

The durable outbound envelope remains unacknowledged. Reload/update the extension as appropriate, or use the manual CLI or experimental Desktop IAB fallback for recovery if the current ChatGPT UI is unsupported. Never bypass this with arbitrary `innerHTML`, debugger access, remote debugging, or broad browser automation.

## Extension service worker or browser restarted

The service worker reloads pairing/binding state from `chrome.storage.local`, reconnects to `ws://127.0.0.1:<relay-port>/relay`, and reauthenticates. Durable outbound envelopes may be redelivered until the corresponding assistant control reply is successfully ingested; that is intentional at-least-once transport with logical deduplication.

After a browser restart, reopen the intended ChatGPT conversation and re-bind if the browser did not preserve the original tab identity. Rerun the local acceptance gate.

## Bound ChatGPT tab was closed

Closing the tab must not advance task state or acknowledge a durable envelope. Reopen the same conversation where possible, verify `workspace_info`, explicitly bind the new tab, and resume from Supervisor/mailbox state.

## `WORKSPACE_MISMATCH`

A control message, task, browser pairing, or ChatGPT connector refers to a different `workspace_id` from the registered local workspace.

1. Run `chat2codex status -w <target-repository> --json`.
2. Run `chat2codex relay status -w <target-repository> --json`.
3. In ChatGPT, verify `workspace_info` through the intended read-only connector.
4. The workspace IDs must match exactly.
5. Unpair/re-pair and re-bind the correct workspace if necessary.

Do not rewrite a task/control message to make a wrong workspace appear to match.

## Unpair and re-pair

~~~bash
chat2codex relay unpair -w <target-repository> --json
chat2codex relay pair -w <target-repository> --json
~~~

Then pair in the popup and explicitly bind the intended ChatGPT tab again.

## Extension artifact / Load unpacked problems

Rebuild:

~~~bash
pnpm build:extension
~~~

Load this directory:

~~~text
<chat2codex-checkout>/dist-extension
~~~

Do not load `extension/`. The built directory must contain `manifest.json`, `service-worker.js`, `content-script.js`, `popup.js`, and `popup.html`.

CI uploads the Node 22 build as `chat2codex-extension-unpacked`; after extraction its root is intended to be usable with Chrome/Edge **Load unpacked**.

## `STALE_BASE`

A `guided` or `patch` task was planned against a Git base that no longer matches the registered primary workspace HEAD, or an existing task worktree has a different base identity.

Let ChatGPT re-read the current workspace and emit a fresh PLAN. Do not force-apply the old patch to the new tree.

## Codex can read but cannot write the task worktree

Chat2Codex invokes non-interactive Codex with:

~~~text
codex --ask-for-approval never exec --json --sandbox workspace-write <prompt>
~~~

Chat2Codex does not use `danger-full-access`.

If Codex cannot create/edit a file:

1. reproduce with a standalone host-side `codex exec --sandbox workspace-write` smoke test, not nested inside another Codex session;
2. verify the current directory is the isolated task worktree;
3. record `codex --version` and the Windows build;
4. do not use `--dangerously-bypass-approvals-and-sandbox`.

If native Windows still behaves read-only, compare with WSL2 before changing Chat2Codex; a WSL2 pass plus native-Windows failure points to the upstream/native sandbox rather than Chat2Codex worktree isolation.

## Codex executable not found

Check:

~~~bash
codex --version
~~~

For a nonstandard installation set `CHAT2CODEX_CODEX_BIN` before starting Chat2Codex.

## Stale daemon lock

A stale lock is one whose recorded process is no longer live. A new `chat2codex start` may remove a stale lock before acquiring its own. Do not delete a lock while its recorded process is live.

## MCP bridge unavailable

`status` should show a loopback bridge. If it does not, ensure `chat2codex start` is running and repair the local bridge before any remote connector path.

The MCP bridge binds only `127.0.0.1`. Do not make it public/unauthenticated to compensate for connector setup.

## ChatGPT can connect but tools are wrong or missing

V1 expects exactly:

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

Do not solve a tool mismatch by granting ChatGPT shell or write access.

## Restricted execution output

`execution_output` may return metadata with `status: restricted` and no body. This is intentional when output contains private-key material or other unsafe content. Review should continue from `git_diff`, readable source, summaries, and other safe evidence.

## Interrupted execution recovery

If the Supervisor disappears while a task is `DISPATCHED` or `EXECUTING`, restart Chat2Codex. Recovery moves the task to:

~~~text
BLOCKED / INTERRUPTED_EXECUTION
~~~

It does not infer success or automatically repeat an unknown partial execution. If evidence was fully persisted and state reached `EXECUTED`, restart recovery republishes `EXECUTED` and resumes review.

## Dirty task worktree cleanup

Reviewed worktrees are intentionally retained. `WorktreeManager.remove()` refuses to delete a dirty task worktree unless force is explicit. Inspect/integrate changes first.

## CI/typecheck failures

CI runs Node 20 and 22 with:

~~~bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
node scripts/acceptance-relay.mjs --help
~~~

It also asserts the built extension files exist. A red CI result is a release blocker. CI is not a substitute for the final real-machine ChatGPT/Chrome/Edge acceptance run.
