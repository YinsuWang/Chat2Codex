# Chat2Codex V1 Architecture Design

Date: 2026-09-10  
Status: Approved architecture baseline  
Repository: `YinsuWang/Chat2Codex`

## 1. Purpose

Chat2Codex is a local-first orchestration system that lets **ChatGPT Chat act as the planner, code designer, and reviewer**, while **Codex CLI acts as the only local executor** with authority to modify files, run shell commands, use project MCP servers, run tests, and interact with Git.

The system exists to solve a specific coordination problem:

- ChatGPT Chat is better suited to long-form project understanding, architectural reasoning, planning, and independent review.
- Codex is better suited to direct local execution because it has immediate access to the working tree, shell, compilers, test runners, project-specific MCP servers, and current filesystem state.
- A local **Supervisor** is required to bind both sides to the same workspace, maintain task state, launch Codex, record execution evidence, and prevent project/session confusion.

The core principle is:

> **ChatGPT owns reasoning and review. Codex owns execution. Supervisor owns orchestration and state.**

## 2. Design goals

V1 must provide the following end-to-end workflow:

1. ChatGPT reads and understands the selected local project through a read-only data channel.
2. ChatGPT produces an implementation instruction in one of three modes: `delegate`, `guided`, or `patch`.
3. The instruction is delivered to a local Supervisor through a control channel that is compatible with the user's current ChatGPT Plus workflow.
4. The Supervisor validates workspace identity and task state.
5. The Supervisor launches Codex CLI in the bound repository or task worktree.
6. Codex performs all filesystem writes, shell commands, Git operations, builds, tests, and project-specific tool calls.
7. The Supervisor records execution metadata and exposes the real diff, test results, logs, and task state to ChatGPT.
8. ChatGPT independently reviews those artifacts and returns `PASS` or `REVISE`.
9. `REVISE` starts another Codex iteration; `PASS` completes the task.

V1 should work without requiring a public server, VPS, fixed public IP, or owned domain.

## 3. Non-goals for V1

The following are deliberately out of scope for the first release:

- Building a full desktop IDE.
- Replacing Codex with a custom coding agent.
- Giving ChatGPT direct shell or arbitrary filesystem write access.
- Multi-user collaboration.
- Cloud-hosted execution.
- Automatic `git push` or merge to protected branches without an explicit policy.
- A rich Electron dashboard.
- Supporting every possible AI coding CLI in V1.

The architecture should leave room for these later without requiring a redesign of the core protocol.

## 4. System architecture

```text
┌─────────────────────────────────────────────┐
│                 ChatGPT Chat                │
│                                             │
│  Project understanding                     │
│  Architecture / planning                   │
│  Code-level design                         │
│  Optional patch generation                 │
│  Independent review                        │
└───────────────┬─────────────────▲───────────┘
                │                 │
       Read-only data plane   Control plane
             (MCP)          (V1: Computer Use)
                │                 │
                ▼                 │
┌─────────────────────────────────────────────┐
│             Chat2Codex Supervisor           │
│                                             │
│  Workspace Registry                        │
│  Workspace Binding                         │
│  Task State Machine                        │
│  Control Transport                         │
│  Codex Adapter                             │
│  Worktree Manager                          │
│  Execution Recorder                        │
│  Policy / Safety Checks                    │
└──────────────────┬──────────────────────────┘
                   │
          local process / JSONL
                   │
                   ▼
┌─────────────────────────────────────────────┐
│                  Codex CLI                  │
│                                             │
│  Read / write files                        │
│  Shell                                     │
│  Git                                       │
│  Build / lint / test                       │
│  Project MCP tools                         │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
             Local Git Worktree
```

## 5. Component responsibilities

### 5.1 ChatGPT Chat

ChatGPT is the primary user-facing planning and review interface.

Responsibilities:

- Read project structure and relevant source files.
- Search code and inspect Git state.
- Understand the user's project-level objective.
- Produce implementation instructions.
- Select an implementation mode.
- Review actual changes after Codex execution.
- Inspect real diffs, logs, and test records instead of trusting a prose claim from Codex.
- Decide `PASS` or `REVISE`.

ChatGPT must not directly:

- Write project files.
- Delete project files.
- Run arbitrary shell commands against the project.
- Commit or push changes.

Those operations belong to Codex.

### 5.2 Supervisor

The Supervisor is a local orchestration service. It is not an AI model.

Responsibilities:

- Maintain the registry of local workspaces.
- Bind each ChatGPT-side connector/session to exactly one local workspace.
- Validate workspace identity before every task or review cycle.
- Persist task state and iteration numbers.
- Receive ChatGPT control messages.
- Convert those messages into Codex execution prompts.
- Launch and supervise `codex exec --json`.
- Capture structured Codex execution events.
- Create and manage task worktrees.
- Record changed files, exit status, tests, logs, and execution metadata.
- Expose read-only project and execution information to ChatGPT.
- Enforce safety and path restrictions.

The Supervisor should not independently decide how application code should be implemented.

### 5.3 Codex CLI

Codex is the sole executor in V1.

Responsibilities:

- Inspect the complete current local project as needed.
- Apply the ChatGPT plan, guided edit, or patch.
- Adapt instructions to the actual local code state.
- Fix integration or type errors discovered during execution.
- Run formatters, linters, builds, tests, and project-specific commands.
- Use project MCP servers where configured.
- Report structured execution events to the Supervisor.

Codex is allowed to reason about local implementation details even when ChatGPT supplies code. It must not be reduced to a blind patch application process.

### 5.4 Worktree

By default, automated tasks should execute in a dedicated Git worktree when the repository supports it.

Goals:

- Protect the user's primary working tree.
- Give each task a stable base commit.
- Make review reproducible.
- Prevent task A from silently changing files used by task B.
- Simplify rollback and cleanup.

For repositories where worktrees are unavailable or inappropriate, the Supervisor may use the current working tree only after an explicit workspace policy permits it.

## 6. Communication model

Chat2Codex uses two logically separate channels.

### 6.1 Data plane: read-only MCP

The data plane lets ChatGPT inspect the project and execution records.

V1 tools should include:

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

These tools must be read-only with respect to the project.

The design intentionally follows the proven pattern used by the user's existing `Codex_with_ChatGPT · PC2` connection: ChatGPT can inspect the local workspace without receiving direct write authority.

### 6.2 Control plane

The control plane carries small structured task-state messages from ChatGPT to the local orchestration layer.

For the user's current Plus-compatible workflow, V1 should use a **Computer Use / UI-mediated control transport**, following the same broad principle as `codex-with-chatgpt`.

The control plane must be abstracted behind a transport interface so future variants can add:

- writable/full MCP control actions where account/product support is available,
- local desktop IPC,
- a browser extension,
- a localhost relay,
- other explicit authenticated transports.

The core Supervisor must not depend on one specific ChatGPT product transport.

### 6.3 Supervisor to Codex

V1 uses a local process adapter rather than another MCP layer.

Conceptually:

```text
Supervisor
    │
    └── spawn codex exec --json ...
            │
            └── JSONL events
```

The adapter captures stdout, stderr, exit status, and Codex JSONL events.

## 7. Workspace binding

Workspace identity must be explicit and machine-local.

### 7.1 Initialization

A user initializes a project with a command equivalent to:

```text
chat2codex init
```

The Supervisor discovers:

- absolute project root,
- Git root,
- repository name,
- current remote if available,
- machine identity,
- a generated immutable `workspace_id`.

Example:

```json
{
  "workspace_id": "ws_a83f21",
  "workspace_name": "BRI_EP_R1",
  "machine": "PC2",
  "root": "D:\\Project\\BRI_EP_R1",
  "git_remote": "..."
}
```

### 7.2 Storage

Machine-specific absolute paths must not be committed to the project repository.

On Windows, V1 should store workspace registry data under a user-local application directory such as:

```text
%LOCALAPPDATA%\Chat2Codex\
```

Example:

```text
Chat2Codex/
  workspaces/
    ws_a83f21.json
  tasks/
  logs/
```

### 7.3 Validation

Every control message must include `workspace_id`.

Before dispatching a task, the Supervisor validates:

- requested `workspace_id` equals the active workspace,
- current project root matches the registry entry,
- expected Git base is still valid when a base SHA is supplied.

A mismatch produces a hard failure such as `WORKSPACE_MISMATCH`; execution must not continue.

## 8. Implementation modes

Chat2Codex supports three levels of delegation.

### 8.1 `delegate`

ChatGPT supplies architecture and implementation intent. Codex determines most concrete code changes.

Best for:

- large refactors,
- unfamiliar or highly connected codebases,
- changes where local discovery is important.

Advantages:

- Codex has complete current local context.
- Lower risk of stale patches.
- Better adaptation to hidden dependencies.

Disadvantages:

- More duplicated reasoning between ChatGPT and Codex.
- Greater risk that Codex interprets the plan differently from ChatGPT.

### 8.2 `guided` — V1 default

ChatGPT supplies the plan plus concrete implementation guidance, file targets, invariants, algorithm details, and key code where useful. Codex performs the actual edits, adapts them to the local code, and validates the result.

Best for most tasks.

Advantages:

- Uses ChatGPT's reasoning more fully.
- Reduces duplicated implementation reasoning.
- Keeps Codex capable of handling local integration details.
- Avoids sending very large patches through the control transport.

Disadvantages:

- Requires clear instruction formatting.
- Codex may still need to diverge from the suggested code when local APIs differ.

### 8.3 `patch`

ChatGPT supplies a complete or near-complete patch/code replacement. Codex validates the base state, applies or adapts the patch, fixes integration issues, and runs verification.

Best for:

- small, local changes,
- obvious bug fixes,
- narrowly scoped code edits.

Advantages:

- Maximum direct use of ChatGPT code generation.
- Minimal ambiguity about intended implementation.

Disadvantages:

- Patches can become stale if the local tree changes.
- Large patches are inefficient and fragile over UI-mediated control transport.
- ChatGPT may not have read every transitive dependency.

### 8.4 Base-state guard

`guided` and especially `patch` messages may include:

```text
base_sha
base_file_hashes
```

The Supervisor or Codex checks these before application. A stale base results in a re-read/re-plan requirement rather than silently applying outdated code.

## 9. Task state machine

V1 task states:

```text
NEW
 ↓
ANALYZING
 ↓
PLANNED
 ↓
DISPATCHED
 ↓
EXECUTING
 ↓
EXECUTED
 ↓
REVIEWING
 ├── PASS ─────→ DONE
 └── REVISE ───→ PLANNED
```

Additional terminal/interruption states:

```text
FAILED
CANCELLED
BLOCKED
```

`EXECUTED` only means Codex finished an execution attempt. It does not mean the implementation is correct.

Only ChatGPT review (or an explicit user override policy) may move a successfully reviewed task to `DONE`.

## 10. Core protocol messages

The first protocol should stay intentionally small.

### 10.1 PLAN

```json
{
  "kind": "PLAN",
  "task_id": "T001",
  "workspace_id": "ws_a83f21",
  "iteration": 1,
  "implementation_mode": "guided",
  "base_sha": "abc123",
  "goal": "...",
  "instructions": [],
  "constraints": [],
  "acceptance_criteria": []
}
```

### 10.2 EXECUTED

```json
{
  "kind": "EXECUTED",
  "task_id": "T001",
  "workspace_id": "ws_a83f21",
  "iteration": 1,
  "exit_code": 0
}
```

This message is only a state transition signal. ChatGPT must read actual evidence separately.

### 10.3 REVIEW

```json
{
  "kind": "REVIEW",
  "task_id": "T001",
  "workspace_id": "ws_a83f21",
  "iteration": 1,
  "decision": "REVISE",
  "findings": [
    {
      "severity": "high",
      "file": "src/example.ts",
      "issue": "...",
      "required_change": "..."
    }
  ]
}
```

`decision` is `PASS` or `REVISE` in the normal review loop.

### 10.4 DONE

```json
{
  "kind": "DONE",
  "task_id": "T001",
  "workspace_id": "ws_a83f21",
  "iteration": 2
}
```

## 11. Task persistence

Supervisor state must survive process restart.

Suggested machine-local structure:

```text
%LOCALAPPDATA%\Chat2Codex\
  workspaces/
  tasks/
    T001/
      task.json
      state.json
      iterations/
        001/
          control-message.json
          codex-events.jsonl
          execution-summary.json
          tests.json
          changed-files.json
        002/
          ...
```

Git diffs do not need to be duplicated indefinitely if they can be reconstructed from a stable base commit and worktree, but V1 may persist compact review snapshots for diagnostics.

## 12. Codex adapter interface

The Supervisor should depend on an abstract adapter rather than directly embedding CLI-specific assumptions everywhere.

Conceptual interface:

```text
CodexAdapter
  start(task, workspace, worktree) -> execution_id
  cancel(execution_id)
  status(execution_id)
  stream(execution_id) -> events
```

V1 implementation:

```text
CodexCLIAdapter
```

Future implementations may include:

```text
CodexAppServerAdapter
CodexDesktopAdapter
```

The transport between ChatGPT and Supervisor must remain independent of the Codex adapter choice.

## 13. Execution records and independent review

ChatGPT review must use primary execution evidence exposed by the Supervisor.

At minimum:

- active branch/worktree,
- base SHA,
- current HEAD SHA if commits are created,
- changed filenames,
- unified diff,
- test/build/lint summaries,
- recorded command output selected by Codex/Supervisor policy,
- Codex exit code,
- task iteration.

A prose summary written by Codex may be shown as supplementary information, but it must not replace these records.

## 14. Error handling

### 14.1 Workspace mismatch

If the control message workspace and active workspace differ:

```text
WORKSPACE_MISMATCH
```

No execution occurs.

### 14.2 Stale base

If `base_sha` or required file hashes no longer match:

```text
STALE_BASE
```

The task returns to planning/review rather than applying an outdated patch blindly.

### 14.3 Codex process failure

If Codex crashes or exits non-zero:

- record the event stream and stderr,
- mark the iteration `FAILED`,
- keep the task/worktree available for diagnosis,
- expose failure evidence to ChatGPT.

### 14.4 Test failure

Test failure does not necessarily mean transport failure.

The iteration becomes `EXECUTED` with failed verification evidence so ChatGPT can decide whether to request revision.

### 14.5 Interrupted Supervisor

On restart, the Supervisor reconstructs task state from disk. Any task previously marked `EXECUTING` without a live Codex process becomes `BLOCKED` or recoverable according to the recorded execution/session state. V1 must never silently mark such tasks `DONE`.

## 15. Security model

V1 follows least privilege.

### ChatGPT side

Allowed:

- project read/search,
- Git diff/status read,
- task/execution record read,
- structured planning/review control messages.

Not allowed:

- arbitrary shell,
- arbitrary project writes,
- direct delete,
- direct Git push.

### Supervisor side

- Only registered workspace roots may be accessed.
- Path traversal outside the registered root is rejected.
- Sensitive file deny-lists apply to read-only MCP tools, including credentials and secret files.
- Control messages require task/workspace identity validation.
- Command execution is performed only through Codex, not through arbitrary ChatGPT-issued shell strings.

### Codex side

Codex executes under the local user's permissions and existing Codex sandbox/approval policy. Chat2Codex must not silently weaken Codex's native safety settings.

## 16. Network and deployment model

V1 is local-first.

Preferred characteristics:

- Supervisor runs on the same machine as the target repository and Codex.
- Read-only MCP exposure uses an authenticated supported tunnel/connector path rather than direct public port exposure.
- No owned domain is required by the core design.
- No inbound router port forwarding is required.

Networking must remain replaceable because ChatGPT connector capabilities can differ by account type and evolve over time.

## 17. V1 project structure

Recommended initial structure:

```text
Chat2Codex/
  src/
    mcp/
      readonly-server/
    supervisor/
      task-manager/
      state-machine/
    codex/
      cli-adapter/
    workspace/
      registry/
      binding/
      worktree-manager/
    execution/
      recorder/
    transport/
      control/
  tests/
  docs/
    superpowers/
      specs/
```

Language/runtime selection is intentionally deferred to the implementation plan, but the design requires first-class Windows support and straightforward process spawning, JSONL parsing, filesystem access, and MCP server support.

## 18. V1 acceptance criteria

V1 is complete when all of the following work in an end-to-end local demonstration:

1. Register a local Git workspace.
2. Connect ChatGPT to its read-only project data tools.
3. Verify `workspace_info` returns a stable workspace identity.
4. ChatGPT inspects source code and produces a `guided` task.
5. The control transport delivers that task to the correct Supervisor/workspace.
6. Supervisor creates or selects an isolated worktree.
7. Supervisor launches Codex CLI and records JSONL execution events.
8. Codex modifies code and runs verification.
9. ChatGPT reads the real diff and test records.
10. ChatGPT can issue `REVISE` and trigger a second Codex iteration.
11. ChatGPT can issue `PASS` and the task transitions to `DONE`.
12. A deliberate workspace mismatch is rejected.
13. A deliberate stale patch/base condition is rejected or re-planned safely.
14. Supervisor restart does not lose task history.

## 19. Design decisions carried into implementation

The following decisions are fixed for V1 unless the architecture itself is explicitly revised:

- ChatGPT is the primary planner and reviewer.
- Codex is the only component that performs project code writes and local execution.
- Supervisor is a deterministic orchestration layer, not another reasoning agent.
- Project inspection uses a read-only MCP-style data plane.
- The Plus-compatible initial control plane does not assume arbitrary writable MCP actions.
- `guided` is the default implementation mode.
- `delegate` and `patch` are supported protocol modes.
- Worktree isolation is the default for Git repositories.
- Workspace identity is explicit and machine-local.
- Review relies on actual diffs/tests/logs, not Codex self-report alone.
- The Codex execution backend is abstracted, with Codex CLI first.
- Domain/public hosting is not a core requirement.

## 20. Future extensions

Once the V1 loop is reliable, likely extensions include:

- writable MCP control transport where supported,
- Codex Desktop/app-server adapters,
- multi-machine workspace registry,
- richer task dashboards,
- desktop notifications,
- controlled merge/cherry-pick workflows,
- resumable long-running Codex sessions,
- multiple concurrent worktrees,
- pluggable execution backends,
- policy profiles for different repositories.

These extensions must preserve the V1 trust boundary: ChatGPT reasons and reviews; execution authority remains in the local executor layer.
