# Chat2Codex V1 Implementation Plan Self-Review Corrections

Date: 2026-09-10  
Status: Normative corrections to `2026-09-10-chat2codex-v1.md`

An executor implementing the V1 plan must read this file together with the main plan. The following corrections override conflicting wording in the main plan.

## 1. Preserve the `ANALYZING` state

The task state union is exactly:

```ts
export type TaskState =
  | "NEW"
  | "ANALYZING"
  | "PLANNED"
  | "DISPATCHED"
  | "EXECUTING"
  | "EXECUTED"
  | "REVIEWING"
  | "DONE"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";
```

The normal first-iteration sequence is:

```text
NEW -> ANALYZING -> PLANNED -> DISPATCHED -> EXECUTING -> EXECUTED -> REVIEWING
```

For Chat-first initiation, the Supervisor does not need to observe ChatGPT's private thinking process. When the first valid `PLAN` arrives for a new task, `TaskService.acceptControlMessage()` must persist the two legal transitions in order:

```text
NEW -> ANALYZING
ANALYZING -> PLANNED
```

This preserves the approved architecture's state model without requiring a separate UI message for `ANALYZING`.

## 2. `REVIEW/PASS` is the normal gate to `DONE`

A task may enter `DONE` only through a successful review transition:

```text
REVIEWING -- REVIEW(decision=PASS) --> DONE
```

`REVIEW(decision=REVISE)` transitions:

```text
REVIEWING -> ANALYZING -> PLANNED
```

for the next iteration.

A standalone inbound `DONE` control message must not bypass review. In V1 it is treated only as an idempotent acknowledgement if the task is already `DONE`; otherwise reject it with `INVALID_TRANSITION`.

The Supervisor may publish a `DONE` message to the outbox after it has accepted `REVIEW/PASS`, so the UI relay can show a terminal acknowledgement in ChatGPT.

## 3. Remote MCP connectivity is an adapter/deployment concern

The Chat2Codex read-only MCP implementation remains a loopback MCP server. V1 must not duplicate a complete public OAuth/tunnel stack merely to expose it.

Preferred deployment order is:

1. Use OpenAI Secure MCP Tunnel when it is available to the user's account/environment and can forward the loopback MCP server.
2. Otherwise use the already proven C2C-style authenticated connector/tunnel path as a compatibility deployment route.
3. Never open an unauthenticated public MCP listener.

Do not document Secure MCP Tunnel as guaranteed by a ChatGPT Plus subscription. Availability and required OpenAI Platform organization/tunnel credentials must be detected/documented at setup time.

## 4. Final acceptance state sequence

The end-to-end test in Task 12 must assert at least this persisted sequence for a one-pass task:

```text
NEW
ANALYZING
PLANNED
DISPATCHED
EXECUTING
EXECUTED
REVIEWING
DONE
```

For a revision loop it must contain:

```text
...
REVIEWING
ANALYZING
PLANNED
DISPATCHED
EXECUTING
EXECUTED
REVIEWING
DONE
```

No direct `NEW -> PLANNED` or `REVIEWING -> PLANNED` transition is valid after this correction.
