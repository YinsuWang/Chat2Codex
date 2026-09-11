# Chat2Codex Control Protocol

ChatGPT is the planning/code-design/review layer. Codex CLI is the local execution layer. The Supervisor owns durable task state. The Desktop relay transports bounded control messages and does not carry repository content.

## Framing

Every UI-relayed control message is exactly:

```text
[CHAT2CODEX]
<one JSON object>
```

The UTF-8 framed message is capped at 16 KiB. File bodies, diffs, and logs never belong in this channel.

Every message carries `workspace_id`, `task_id`, and `iteration`.

## ChatGPT boot contract

Use the following as the reusable instruction for the bound ChatGPT chat/project:

```text
You are the planning, code-design, and independent review layer for one Chat2Codex local workspace. Codex executes locally; you do not receive project write or shell tools.

Before planning any code change, call workspace_info through the bound Chat2Codex connector and verify the returned workspace_id is the expected workspace for this chat. If it differs, stop and report WORKSPACE_MISMATCH.

Read project structure, source, Git state, diffs, task state, and released execution evidence through the read-only connector. Never ask the relay or user to paste file bodies, diffs, or logs.

For a new coding request, emit one [CHAT2CODEX] PLAN JSON message. Default implementation_mode is guided: provide the implementation intent, concrete file-level guidance, constraints, and acceptance criteria. Use delegate for broad local discovery/refactors and patch only for small changes where the base is known and the patch comfortably fits the bounded control channel.

After an EXECUTED message, independently inspect git_diff, execution_summary, test_status, and readable execution_output when useful. Then emit exactly one REVIEW message with decision PASS or REVISE. Do not treat Codex's prose as proof. On REVISE, provide concrete findings; on PASS, findings may be empty.

Keep control messages bounded. Put no repository files, diffs, command logs, credentials, cookies, or local absolute paths into them.
```

## PLAN

Example:

```text
[CHAT2CODEX]
{"kind":"PLAN","workspace_id":"ws_a83f21","task_id":"task_001","iteration":1,"implementation_mode":"guided","base_sha":"abc123","goal":"Add retry handling","instructions":["Update the retry policy and preserve the public API"],"constraints":["Do not change the MCP protocol"],"acceptance_criteria":["Existing tests pass","Retry behavior is covered"]}
```

`guided` is the default. `patch` requires a non-empty `patch` field; non-patch modes must not include one.

## EXECUTED

Supervisor-generated only:

```text
[CHAT2CODEX]
{"kind":"EXECUTED","workspace_id":"ws_a83f21","task_id":"task_001","iteration":1,"exit_code":0,"changed_files":3,"tests_summary":"Codex process exited successfully; inspect recorded outputs for test details."}
```

`EXECUTED` means an execution attempt finished and evidence was persisted. It is not a correctness decision.

## REVIEW

Revision example:

```text
[CHAT2CODEX]
{"kind":"REVIEW","workspace_id":"ws_a83f21","task_id":"task_001","iteration":1,"decision":"REVISE","findings":[{"severity":"high","file":"src/retry.ts","issue":"Backoff ignores cancellation","required_change":"Propagate the abort signal through each retry delay"}]}
```

Pass example:

```text
[CHAT2CODEX]
{"kind":"REVIEW","workspace_id":"ws_a83f21","task_id":"task_001","iteration":2,"decision":"PASS","findings":[]}
```

Only a valid REVIEW/PASS may approve the implementation. Normal prose never implies PASS.

## DONE

A DONE acknowledgement may be used only after review approval:

```text
[CHAT2CODEX]
{"kind":"DONE","workspace_id":"ws_a83f21","task_id":"task_001","iteration":2,"summary":"Reviewed and accepted."}
```

## Evidence path

ChatGPT reviews primary local evidence through MCP rather than the UI channel:

- `workspace_info`
- `read_file` / `search_workspace`
- `git_status` / `git_diff`
- `task_get` / `task_history`
- `execution_summary`
- `test_status`
- `execution_output` (only sanitized readable bodies)

The relay must never substitute pasted evidence for these tools.
