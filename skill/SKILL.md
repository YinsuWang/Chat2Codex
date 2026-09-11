---
name: chat2codex-relay
description: Use when a Codex Desktop session must relay Chat2Codex control messages between a bound ChatGPT chat and the local Chat2Codex Supervisor.
---

# Chat2Codex Relay

This Desktop session is a transport, not the coding decision-maker.

## Non-negotiable roles

- ChatGPT owns planning, code-level guidance, and review.
- The Chat2Codex Supervisor owns task/workspace state.
- `CodexCLIAdapter` owns project execution.
- This Desktop session only relays control messages. Never reinterpret, summarize, merge, repair, or silently approve a `PLAN` or `REVIEW` message.
- Never paste repository files, diffs, or logs into ChatGPT. ChatGPT reads them through the read-only MCP connector.
- Only relay messages whose first line is exactly `[CHAT2CODEX]`.
- Use only the workspace connector and workspace ID reported by `chat2codex status` for this task.

## Browser surface

Use Codex Desktop's built-in in-app browser only. Do not use screenshot-based Computer Use and do not automate an external browser.

Once per Desktop session, initialize the browser runtime, get the `iab` browser, and reuse it. Keep exactly one ChatGPT tab. If the tab exists, reuse it; do not open a second tab because a wait timed out.

Keep the tab visible. Mark it for handoff at the start/end of relay activity and keep it alive between turns. Do not close the tab when waiting.

## Relay loop

1. Run `chat2codex status -w <workspace> --json` and verify the expected workspace ID.
2. Run `chat2codex control next --workspace <workspace_id> --json`.
3. If an outbound envelope exists, send its formatted `[CHAT2CODEX]` body unchanged to the bound ChatGPT chat.
4. Wait for ChatGPT to finish. Use cheap DOM checks at bounded intervals; a browser timeout is not a reason to resend.
5. Read only the latest assistant block beginning with `[CHAT2CODEX]`.
6. Pipe that block unchanged to `chat2codex control ingest --workspace <workspace_id> --stdin`.
7. Acknowledge the outbound envelope only after the send succeeded and the corresponding assistant control reply was ingested successfully.
8. Repeat.

When no outbound envelope exists, still inspect the current bound chat for a new assistant `[CHAT2CODEX]` block. This is required for Chat-first tasks: the user may ask ChatGPT for a code change before the Supervisor has emitted anything. A fresh `PLAN` must be ingested exactly once.

## Review loop

After relaying `EXECUTED`, do not judge the implementation yourself. ChatGPT must inspect the real evidence through MCP (`git_diff`, `execution_summary`, `test_status`, and readable `execution_output`) and return either `REVIEW/PASS` or `REVIEW/REVISE`.

Normal prose is never an implicit PASS. Only a valid `[CHAT2CODEX]` control message may advance the protocol.

## Waiting and duplication safety

- Never resend an outbound envelope merely because ChatGPT is still generating or a DOM wait timed out.
- Never ingest the same assistant control block twice.
- Never switch workspace connectors inside a bound chat.
- If the workspace ID shown by ChatGPT/MCP differs from `chat2codex status`, stop relaying and surface `WORKSPACE_MISMATCH`.
- If the ChatGPT tab is lost, reopen the bound chat and resume from Supervisor/mailbox state; do not invent a new task or iteration.
