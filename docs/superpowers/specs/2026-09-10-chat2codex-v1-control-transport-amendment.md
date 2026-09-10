# Chat2Codex V1 Control Transport Amendment

Date: 2026-09-10  
Status: Architecture clarification  
Applies to: `docs/superpowers/specs/2026-09-10-chat2codex-v1-design.md`

## Why this amendment exists

The approved V1 design correctly separates the read-only data plane from the control plane, but its phrase `V1: Computer Use` is too imprecise for implementation.

The current `XiaoDuoYa/codex-with-chatgpt` architecture describes the control plane generically as Computer Use/UI-mediated control, while its latest Codex Skill implementation explicitly uses the Codex Desktop built-in in-app browser (`iab`) and explicitly avoids screenshot-based Computer Use. That implementation detail matters because `codex exec` by itself must not be assumed to own the same in-app browser control surface.

This amendment therefore separates **Chat control transport** from **Codex execution transport**.

## Revised V1 control architecture

```text
┌─────────────────────────────────────────────┐
│                 ChatGPT Chat                │
│                                             │
│ Plan / guided code / patch / review         │
└──────────────┬──────────────────▲───────────┘
               │                  │
        Read-only MCP       UI control relay
               │          (Codex Desktop IAB)
               │                  │
               ▼                  ▼
┌─────────────────────────────────────────────┐
│             Chat2Codex Supervisor           │
│                                             │
│ Workspace binding                           │
│ Task state                                  │
│ Control inbox/outbox                        │
│ Execution records                           │
│ Codex adapter                               │
└──────────────────┬──────────────────────────┘
                   │
          CodexCLIAdapter / JSONL
                   │
                   ▼
                Codex CLI
                   │
                   ▼
              Git worktree
```

## Fixed V1 decisions

1. `ControlTransport` and `CodexAdapter` are separate interfaces.
2. `CodexCLIAdapter` remains the default execution backend in V1.
3. The Plus-compatible automatic UI relay is provided by a Codex Desktop Skill using the built-in in-app browser (`iab`).
4. The Desktop relay is deliberately thin: it moves small structured control messages between the ChatGPT conversation and the Supervisor inbox/outbox. It does not inspect repository files or make implementation decisions on behalf of ChatGPT.
5. Repository content, diffs, logs, and execution evidence continue to move through the read-only MCP data plane; the UI relay carries only bounded control messages.
6. The Supervisor must not assume `codex exec` has browser-control capabilities.
7. A CLI-only machine can still use `CodexCLIAdapter` as the executor, but fully automatic ChatGPT UI relay without Codex Desktop requires another future `ControlTransport` such as writable MCP, a browser extension, or another authenticated local relay.
8. A manual stdin control transport may exist for development and recovery, but it is not the intended primary user experience.

## Control transport interface

Conceptually:

```ts
export interface ControlTransport {
  publish(message: ControlMessage): Promise<void>;
  receive(): Promise<ControlMessage | null>;
}
```

The Supervisor should implement its durable side as a machine-local inbox/outbox. The Codex Desktop Skill consumes outbound messages, sends them in the bound ChatGPT chat, waits for the structured reply, and writes the reply into the inbound queue through a local CLI command.

## V1 message path

A normal iteration is:

```text
User asks in ChatGPT Chat
        ↓
ChatGPT reads workspace through MCP
        ↓
ChatGPT emits PLAN / REVIEW
        ↓
Codex Desktop IAB relay reads structured reply
        ↓
chat2codex control ingest
        ↓
Supervisor validates workspace/task/base
        ↓
CodexCLIAdapter runs codex exec --json
        ↓
Supervisor records execution evidence
        ↓
chat2codex control next returns EXECUTED
        ↓
Codex Desktop IAB relay sends EXECUTED to ChatGPT
        ↓
ChatGPT reads diff/tests through MCP
        ↓
PASS / REVISE
```

## Consequence for V1 acceptance

The V1 end-to-end automatic demonstration therefore requires Codex Desktop for the UI relay even when Codex CLI performs the actual code execution. This is an intentional compatibility choice for the user's current Plus workflow, not a permanent coupling of the Supervisor to Codex Desktop.

A later transport may remove the Desktop relay without changing workspace binding, task state, execution recording, MCP tools, worktree management, or the Codex execution adapter.
