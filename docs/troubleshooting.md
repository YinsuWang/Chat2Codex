# Chat2Codex Troubleshooting

Start with:

```bash
chat2codex doctor -w <target-repository> --json
chat2codex status -w <target-repository> --json
```

Do not repair a workspace by deleting state or worktrees blindly. Chat2Codex intentionally persists task identity and evidence across restarts.

## `WORKSPACE_MISMATCH`

Meaning: a control message, task, or ChatGPT connector refers to a different `workspace_id` from the registered local workspace.

Actions:

1. Run `chat2codex status -w <target-repository> --json`.
2. In the bound ChatGPT chat, call `workspace_info` through the intended connector.
3. The two workspace IDs must match exactly.
4. If ChatGPT is using another workspace connector, stop the relay and bind the correct connector. Do not rewrite the local task to match the wrong connector.

No worktree or Codex execution should start after this error.

## `STALE_BASE`

Meaning: a `guided` or `patch` task was planned against a Git base that no longer matches the registered primary workspace HEAD, or an existing task worktree has a different base identity.

Action: let ChatGPT re-read the current workspace and emit a fresh PLAN. Do not force-apply the old patch to the new tree.

## `Codex executable not found`

Check:

```bash
codex --version
```

For a nonstandard installation set `CHAT2CODEX_CODEX_BIN` to the executable path before starting Chat2Codex.

## Stale daemon lock

`doctor` reports whether a daemon lock refers to a live process. If the old process is definitely gone, a new `chat2codex start` removes a stale lock before acquiring its own. Do not delete a lock while the recorded process is still live.

## MCP bridge unavailable

`status` should show a loopback bridge. If it does not:

1. ensure `chat2codex start` is running,
2. run `doctor`,
3. confirm the local bridge is healthy before repairing the remote connector/tunnel.

The Chat2Codex bridge binds only `127.0.0.1`. ChatGPT cannot connect directly to localhost; the supported authenticated remote transport must also be healthy.

## ChatGPT can connect but tools are wrong/missing

Verify the bound connector points to this workspace's Chat2Codex MCP bridge and call `workspace_info`. V1 expects exactly these read-only capabilities:

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

Do not solve a tool mismatch by giving ChatGPT shell or write access.

## Restricted execution output

`execution_output` may return metadata with `status: restricted` and no body. This is intentional when output contains private-key material or other unsafe content. ChatGPT should continue review from `git_diff`, source files, summaries, and other readable evidence.

## Interrupted execution recovery

If the Supervisor process disappears while a task is `DISPATCHED` or `EXECUTING`, restart Chat2Codex. Recovery moves the task to:

```text
BLOCKED / INTERRUPTED_EXECUTION
```

It does not infer success and does not automatically repeat an unknown partial execution. Re-plan/resume explicitly after inspecting the task worktree.

If execution evidence was fully persisted and state reached `EXECUTED` before the interruption, restart recovery republishes the `EXECUTED` notification and moves the task to `REVIEWING`.

## Dirty task worktree cleanup

Reviewed worktrees are intentionally retained. `WorktreeManager.remove()` refuses to delete a dirty task worktree unless force is explicit. Inspect/integrate the changes first; force cleanup is a deliberate destructive action, not routine recovery.

## ChatGPT conversation binding was lost

Do not create a new task just because the browser tab disappeared.

1. Reopen the bound ChatGPT chat/project.
2. Verify `workspace_info` matches the local workspace ID.
3. Read local state with `chat2codex status` and the task/evidence MCP tools.
4. Resume from the Supervisor mailbox/task state.

Never reconstruct the task by pasting repository files, diffs, or logs into ChatGPT.

## Desktop relay is not installed

Install `skill/SKILL.md` under a Codex-recognized `chat2codex-relay` Skill directory, then rerun doctor. V1 automatic ChatGPT UI control requires Codex Desktop's built-in in-app browser; Codex CLI remains the execution backend.

## CI/typecheck failures

The feature branch CI runs Node 20 and 22 with:

```bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
```

Treat a red CI result as a release blocker. Do not infer success from local ad-hoc smoke tests when dependency-level CI is failing.
