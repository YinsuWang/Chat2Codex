# Complete V1 Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Combine the accepted Core V1, Browser Extension Relay, and authenticated Remote MCP transport into one diagnosable ChatGPT-first workflow that can complete `PLAN -> EXECUTED -> REVIEW -> DONE` with real Codex execution on the user's Windows machine.

**Architecture:** Preserve the three independent boundaries: Core execution (Supervisor/Codex/worktree), read-only data plane (authenticated Remote MCP), and control plane (Browser Extension Relay). Add one machine-local integration profile and combined status/doctor/acceptance layer that verifies these components agree on the same workspace without making them share credentials or failure domains. Complete V1 is released only after a real ChatGPT Web acceptance run proves ChatGPT reads evidence through MCP and the extension relays structured control messages without repository mutation access.

**Tech Stack:** Existing Chat2Codex Core V1 + Browser Extension Relay plan + Remote MCP Transport plan; Node.js >=20, TypeScript 5.9+, Commander 14, Vitest 3.x, Chrome/Edge Chromium 116+.

**Spec:** `docs/superpowers/specs/2026-09-14-chat2codex-integration-transport-design.md`

**Prerequisite plans:**
- `docs/superpowers/plans/2026-09-14-browser-extension-relay.md`
- `docs/superpowers/plans/2026-09-14-remote-mcp-transport.md`

## Global Constraints

- Core V1 acceptance must remain green; do not weaken worktree, stale-base, workspace binding, sanitizer, or read-only MCP protections.
- Data plane and control plane remain independently authenticated and independently diagnosable.
- Relay token is never accepted as MCP bearer token; MCP OAuth token is never accepted by the relay server.
- ChatGPT still has no mutation MCP tools.
- Extension still receives no repository files/diffs/logs.
- Workspace ID must match across Core status, remote MCP `workspace_info`, extension binding, and every control message.
- Natural-language assistant text is never an implicit PLAN, REVIEW, PASS, or DONE; only valid `[CHAT2CODEX]` protocol messages advance task state.
- A remote-MCP outage cannot mark a task DONE; a relay outage cannot alter Core task state.
- No auto-merge or auto-push.
- Complete V1 acceptance requires a real ChatGPT Web conversation, not only mocks/fixtures.

## File Structure

```text
src/integration/types.ts                    integration profile/status types
src/integration/store.ts                    machine-local profile persistence
src/integration/service.ts                  cross-component consistency checks
src/cli/commands/integration.ts             setup/status/acceptance-preflight CLI
src/cli/commands/start.ts                   start configured local integration services
src/cli/commands/status.ts                  combined Core/data/control view
src/cli/commands/doctor.ts                  combined classification without false Core failures
src/cli/index.ts                            integration command registration
docs/protocol.md                            ChatGPT boot/control contract for extension path
docs/setup.md                               end-to-end installation order
docs/troubleshooting.md                     classified recovery procedures
README.md                                   Complete V1 workflow/status
scripts/acceptance-complete-v1.mjs          machine preflight + result collection
scripts/acceptance-chatgpt-first.ps1        Windows host acceptance helper
.github/workflows/ci.yml                    complete regression gate
tests/integration/*.test.ts                 profile/consistency/status tests
tests/e2e/complete-local-stack.test.ts      Core + relay + authenticated MCP local stack
```

---

### Task 1: Integration profile and cross-component identity model

**Files:**
- Create: `src/integration/types.ts`
- Create: `src/integration/store.ts`
- Test: `tests/integration/store.test.ts`

**Interfaces:**
- Produces:

```ts
export interface IntegrationProfile {
  workspace_id: string;
  control_transport: "browser-extension" | "desktop-iab" | "manual";
  remote_mcp_provider: "external" | "cloudflare-quick" | "cloudflare-named" | null;
  remote_auto_start: boolean;
  expected_connector_name: string | null;
  created_at: string;
  updated_at: string;
}

export class IntegrationProfileStore {
  get(workspaceId: string): Promise<IntegrationProfile | null>;
  put(profile: IntegrationProfile): Promise<void>;
  clear(workspaceId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing persistence/validation tests**

Cover:
- only known transport/provider enums accepted;
- workspace ID path-safe validation;
- connector name max 128 characters and no control characters;
- no remote URL, OAuth token, relay token, absolute workspace path, or browser cookie belongs in this profile;
- atomic machine-local persistence.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/integration/store.test.ts
```

- [ ] **Step 3: Implement machine-local profile storage**

Persist:

```text
<stateDir>/integration/<workspace_id>.json
```

Use mode `0o600`, temp-file + rename, and exact schema validation on read.

- [ ] **Step 4: Run tests/typecheck**

```bash
pnpm vitest run tests/integration/store.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/integration tests/integration/store.test.ts
git commit -m "feat: add Complete V1 integration profile"
```

---

### Task 2: Combined integration service and failure classification

**Files:**
- Create: `src/integration/service.ts`
- Test: `tests/integration/service.test.ts`

**Interfaces:**
- Consumes: workspace registry, daemon/bridge runtime, relay runtime/status, remote MCP status, integration profile.
- Produces:

```ts
export type IntegrationBlockerCode =
  | "CORE_NOT_RUNNING"
  | "RELAY_NOT_PAIRED"
  | "NO_BOUND_TAB"
  | "RELAY_UI_UNSUPPORTED"
  | "REMOTE_MCP_NOT_CONFIGURED"
  | "REMOTE_MCP_UNHEALTHY"
  | "CHATGPT_CONNECTOR_NOT_VERIFIED"
  | "WORKSPACE_MISMATCH";

export interface IntegrationStatus {
  workspace_id: string;
  core_ready: boolean;
  control_ready: boolean;
  data_ready: boolean;
  complete_ready: boolean;
  blockers: Array<{ code: IntegrationBlockerCode; detail: string }>;
}

export class IntegrationService {
  status(workspace: WorkspaceRecord): Promise<IntegrationStatus>;
}
```

- [ ] **Step 1: Write table-driven failing status tests**

Cover these exact classifications:

```text
Core down + everything else down          -> CORE_NOT_RUNNING
Core up, relay unpaired                    -> RELAY_NOT_PAIRED
Relay paired, no heartbeat/bound tab       -> NO_BOUND_TAB
Relay reports unsupported DOM              -> RELAY_UI_UNSUPPORTED
Remote provider absent                     -> REMOTE_MCP_NOT_CONFIGURED
Remote configured but unhealthy            -> REMOTE_MCP_UNHEALTHY
Everything local healthy but no connector verification -> CHATGPT_CONNECTOR_NOT_VERIFIED
Any component reports another workspace    -> WORKSPACE_MISMATCH
All healthy/verified                        -> complete_ready=true, blockers=[]
```

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/integration/service.test.ts
```

- [ ] **Step 3: Implement status aggregation without credential sharing**

Only consume public status projections from each subsystem. Do not read OAuth/relay raw token stores. Workspace equality is checked using workspace IDs from runtime metadata/status responses.

- [ ] **Step 4: Define connector verification marker**

Add a machine-local verification record written only after a successful authenticated `workspace_info` check from ChatGPT acceptance/setup flow:

```ts
interface ConnectorVerification {
  workspace_id: string;
  connector_name: string;
  verified_at: string;
  public_endpoint_fingerprint: string;
}
```

Store endpoint fingerprint as SHA-256 of normalized public MCP URL, not the URL itself in the integration profile. A changed Quick Tunnel URL invalidates verification.

- [ ] **Step 5: Run tests/typecheck**

```bash
pnpm vitest run tests/integration/service.test.ts
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/integration tests/integration/service.test.ts
git commit -m "feat: classify Chat2Codex integration readiness"
```

---

### Task 3: `integration` CLI and combined start/status/doctor behavior

**Files:**
- Create: `src/cli/commands/integration.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/integration/cli.test.ts`
- Test: `tests/e2e/integration-start-order.test.ts`

**Interfaces:**
- CLI:

```text
chat2codex integration configure -w <workspace> --control browser-extension --remote <provider> --json
chat2codex integration status -w <workspace> --json
chat2codex integration verify-connector -w <workspace> --name <connector-name> --endpoint <https-url> --json
chat2codex integration clear-connector-verification -w <workspace> --json
```

- [ ] **Step 1: Write failing CLI tests**

Assert:
- browser-extension is default control transport for new Complete V1 profiles;
- Desktop IAB can be selected only explicitly and is reported experimental;
- verify-connector never accepts localhost/http public endpoint except test mode;
- `status --json` keeps existing Core fields and adds nested `integration` rather than breaking consumers;
- `doctor` reports integration blockers separately while retaining individual Core check outcomes.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/integration/cli.test.ts tests/e2e/integration-start-order.test.ts
```

- [ ] **Step 3: Implement integration command group**

Configuration writes only the profile from Task 1. `verify-connector` writes the connector verification record after checking normalized endpoint matches the currently running remote provider status.

- [ ] **Step 4: Extend `start` lifecycle**

Required order under daemon lock:

```text
acquire daemon lock
→ start local MCP bridge
→ start browser relay server
→ if profile.remote_auto_start: start authenticated remote MCP gateway/provider
→ recover Supervisor tasks
→ enter Supervisor loop
```

If any integration service startup fails before Supervisor loop, clean up all services started by this process in reverse order and release lock. Never overwrite runtime metadata before lock acquisition.

- [ ] **Step 5: Extend human/JSON status**

JSON keeps stable Core keys and adds:

```ts
integration: IntegrationStatus
```

Human output clearly distinguishes:

```text
Core: ready
Control: ready / blocker-code
Data: ready / blocker-code
Complete V1: ready / blocked
```

- [ ] **Step 6: Run focused/full regression**

```bash
pnpm vitest run tests/integration/cli.test.ts tests/e2e/integration-start-order.test.ts
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/cli src/integration tests/integration tests/e2e/integration-start-order.test.ts
git commit -m "feat: expose Complete V1 integration lifecycle"
```

---

### Task 4: Update ChatGPT protocol/boot contract for extension relay

**Files:**
- Modify: `docs/protocol.md`
- Modify: `extension/src/content-script.ts`
- Modify: `extension/src/popup.ts`
- Test: `tests/integration/protocol-contract.test.ts`

**Interfaces:**
- ChatGPT control output remains existing `[CHAT2CODEX]` protocol.
- Adds a documented boot verification sequence, not new repository mutation capabilities.

- [ ] **Step 1: Write protocol-contract tests**

Parse `docs/protocol.md` and assert it includes these hard requirements:

```text
workspace_info before first PLAN
workspace_id equality
browser extension is transport only
ChatGPT must inspect git_diff + execution_summary + test_status after EXECUTED
normal prose is not PASS
DONE only after REVIEW/PASS
```

Also assert content script only extracts blocks with exact first line `[CHAT2CODEX]`.

- [ ] **Step 2: Run RED if current docs are incomplete**

```bash
pnpm vitest run tests/integration/protocol-contract.test.ts
```

- [ ] **Step 3: Rewrite boot sequence for Complete V1**

Document the first bound-chat sequence:

```text
1. ChatGPT calls workspace_info through the configured connector.
2. It verifies expected workspace_id.
3. It reads only the minimum files needed for the user request.
4. It emits exactly one PLAN control block.
5. After EXECUTED, it reads git_diff, execution_summary, test_status and source files if needed.
6. It emits REVIEW/PASS or REVIEW/REVISE.
7. DONE follows only a valid PASS transition.
```

- [ ] **Step 4: Add popup boot-check guidance without automating connector settings**

When a tab is bound but connector verification is absent, popup shows a concise action: verify the ChatGPT connector and `workspace_info` before starting a task. Do not DOM-automate ChatGPT settings or login.

- [ ] **Step 5: Run tests/build**

```bash
pnpm vitest run tests/integration/protocol-contract.test.ts
pnpm build:extension
```

- [ ] **Step 6: Commit**

```bash
git add docs/protocol.md extension tests/integration/protocol-contract.test.ts
git commit -m "docs: define Complete V1 ChatGPT protocol contract"
```

---

### Task 5: Complete local-stack deterministic E2E

**Files:**
- Create: `tests/e2e/complete-local-stack.test.ts`
- Modify: only integration code if the test exposes a bug

**Interfaces:**
- Uses real local bridge, authenticated remote gateway, relay server, durable ControlService, Supervisor with fake Codex, and a WebSocket client simulating extension. It does not contact ChatGPT.com in CI.

- [ ] **Step 1: Build a deterministic Git fixture**

Create temp repo with one source/test file and registered workspace. Start all local services on ephemeral loopback ports with a complete integration profile.

- [ ] **Step 2: Run authenticated data-plane setup in test**

Register OAuth client, approve pairing, obtain token, connect MCP client, and verify `workspace_info` returns the same workspace ID as Core/relay.

- [ ] **Step 3: Run control-plane task loop**

Simulated assistant sends PLAN through relay. Supervisor with fake Codex records one changed file and emits EXECUTED. Simulated assistant receives EXECUTED, MCP client reads real recorded evidence, then sends REVIEW/PASS. Supervisor reaches DONE.

- [ ] **Step 4: Assert security/isolation invariants**

Assert:
- no MCP mutation tools;
- extension client receives no source/diff/log body except bounded control text;
- main fixture worktree unchanged;
- wrong-workspace token/control message rejected;
- disconnect between EXECUTED and REVIEW leaves durable state recoverable;
- replay after reconnect does not create duplicate transition.

- [ ] **Step 5: Run E2E + complete suite**

```bash
pnpm vitest run tests/e2e/complete-local-stack.test.ts
pnpm test
pnpm typecheck
pnpm build
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/complete-local-stack.test.ts src/integration src/relay src/remote-mcp
git commit -m "test: verify Complete V1 local integration stack"
```

---

### Task 6: Windows machine acceptance tooling

**Files:**
- Create: `scripts/acceptance-complete-v1.mjs`
- Create: `scripts/acceptance-chatgpt-first.ps1`
- Test: `tests/integration/acceptance-script.test.ts`

**Interfaces:**
- Script does not automate ChatGPT login/settings; it collects local evidence and gives the user/Codex exact next action for the real ChatGPT step.

- [ ] **Step 1: Write acceptance-script tests**

Mock command/status sources and verify JSON report fields:

```ts
interface CompleteV1AcceptanceReport {
  tested_sha: string;
  core: "PASS" | "FAIL";
  relay: "PASS" | "FAIL" | "BLOCKED";
  remote_mcp: "PASS" | "FAIL" | "BLOCKED";
  connector_verified: boolean;
  local_stack: "PASS" | "FAIL";
  chatgpt_first_e2e: "PASS" | "FAIL" | "NOT_RUN";
  blockers: string[];
}
```

No raw tokens, credential URLs, home paths, or repository absolute paths in JSON output.

- [ ] **Step 2: Implement local preflight script**

`scripts/acceptance-complete-v1.mjs --json` checks current SHA, local tests/build availability, integration status, runtime health and main worktree cleanliness. It never marks ChatGPT E2E PASS by inference.

- [ ] **Step 3: Implement PowerShell host helper**

`scripts/acceptance-chatgpt-first.ps1` runs from ordinary Windows PowerShell 7 and:
- starts/validates Chat2Codex services if not already healthy;
- prints connector endpoint/setup fields without printing OAuth/relay tokens;
- prints the exact test task text;
- waits for task state with bounded polling;
- captures final status/evidence summaries and main worktree cleanliness;
- asks user to confirm ChatGPT-side workspace verification/review only where local automation cannot prove it.

It must not automate browser login or use `danger-full-access`.

- [ ] **Step 4: Run script tests**

```bash
pnpm vitest run tests/integration/acceptance-script.test.ts
node scripts/acceptance-complete-v1.mjs --help
```

- [ ] **Step 5: Commit**

```bash
git add scripts tests/integration/acceptance-script.test.ts
git commit -m "test: add Complete V1 machine acceptance tooling"
```

---

### Task 7: Release documentation and CI gate

**Files:**
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `docs/troubleshooting.md`
- Modify: `docs/extension-install.md`
- Modify: `skill/SKILL.md`
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json` only for final script aliases if needed

**Interfaces:**
- Complete V1 user path is ChatGPT Web + Browser Extension Relay + authenticated Remote MCP + local Supervisor/Codex.

- [ ] **Step 1: Update README status/architecture**

Document:
- Core V1 accepted baseline;
- Browser Extension Relay default;
- Desktop IAB experimental fallback;
- three Remote MCP provider options;
- Complete V1 release gate.

Do not state Complete V1 accepted before real-machine final acceptance.

- [ ] **Step 2: Write setup sequence in operational order**

Required order:

```text
install/build Chat2Codex
→ register workspace
→ configure integration profile
→ start local services
→ pair/load extension
→ configure authenticated Remote MCP connector
→ verify workspace_info
→ bind ChatGPT tab
→ run acceptance task
```

- [ ] **Step 3: Write classified troubleshooting matrix**

Map blocker codes to component and action. Examples:

```text
RELAY_NOT_PAIRED              control plane
NO_BOUND_TAB                  control plane
RELAY_UI_UNSUPPORTED          browser adapter
REMOTE_MCP_NOT_CONFIGURED     data plane
REMOTE_MCP_UNHEALTHY          data plane/network
CHATGPT_CONNECTOR_NOT_VERIFIED ChatGPT integration
WORKSPACE_MISMATCH            safety stop
```

Never suggest weakening sandbox/authentication to repair these.

- [ ] **Step 4: Harden CI release gate**

Node 20/22 CI runs:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
node scripts/acceptance-complete-v1.mjs --help
```

Also assert built extension manifest/service worker/content script exist.

- [ ] **Step 5: Run final deterministic verification**

```bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
node scripts/acceptance-complete-v1.mjs --help
```

Expected: PASS before machine acceptance begins.

- [ ] **Step 6: Commit**

```bash
git add README.md docs skill .github/workflows/ci.yml package.json
git commit -m "docs: prepare Complete V1 integration acceptance"
```

---

### Task 8: Real ChatGPT-first Complete V1 acceptance

**Files:**
- No production code unless acceptance exposes a reproducible product defect.
- If a defect is found: add the smallest regression test in the owning subsystem before fixing it.

**Interfaces:**
- Real user's Windows host, real Chrome/Edge extension, real ChatGPT Web account/environment, real authenticated remote MCP connector, real Codex CLI.

- [ ] **Step 1: Verify deterministic gates first**

Confirm feature branch HEAD has green Node 20/22 CI and ordinary Windows host passes:

```powershell
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
node scripts/acceptance-complete-v1.mjs --json
```

- [ ] **Step 2: Load extension and pair/bind**

Load `dist-extension/` unpacked in current Chrome/Edge. Run `chat2codex relay pair`, enter the short code in popup, then bind exactly one ChatGPT conversation tab. Confirm `chat2codex integration status --json` reports control plane ready.

- [ ] **Step 3: Establish/verify authenticated Remote MCP connector**

Configure the currently selected provider. In ChatGPT, connect the resulting authenticated read-only MCP endpoint. Execute `workspace_info`; compare returned workspace ID to local `chat2codex status`. Record connector verification only after equality is proven.

- [ ] **Step 4: Run the canonical real task**

User message:

```text
请为 greet(name) 增加空字符串处理：空字符串时返回 Hello stranger，并补充测试。请使用 Chat2Codex 完成。
```

Required observed flow:

```text
workspace_info
→ PLAN
→ extension relay
→ Supervisor
→ real codex --ask-for-approval never exec --json --sandbox workspace-write
→ isolated worktree changes
→ tests
→ EXECUTED
→ extension relay
→ ChatGPT reads git_diff + execution_summary + test_status
→ REVIEW/PASS or REVIEW/REVISE
→ DONE
```

- [ ] **Step 5: Run resilience checks**

During separate acceptance tasks:
- restart extension service worker/browser and prove pending envelope recovers without duplicate transition;
- close bound tab and prove mailbox/task state remains intact;
- disconnect Remote MCP before REVIEW and prove task does not silently reach DONE;
- attempt wrong workspace binding and prove `WORKSPACE_MISMATCH` stops relay;
- verify main working tree remains clean and no auto-push/merge occurs.

- [ ] **Step 6: Produce final acceptance report**

Report exact tested SHA and fields:

```text
Core V1: PASS/FAIL
Browser Extension Relay: PASS/FAIL
Authenticated Remote MCP: PASS/FAIL
ChatGPT workspace verification: PASS/FAIL
Real Codex execution: PASS/FAIL
ChatGPT evidence review: PASS/FAIL
PLAN -> EXECUTED -> REVIEW -> DONE: PASS/FAIL
Restart/recovery: PASS/FAIL
Security/isolation: PASS/FAIL
Final decision: ACCEPT / ACCEPT_WITH_LIMITATIONS / REJECT
```

Do not declare `ACCEPT` unless the real ChatGPT-first chain reaches DONE from a valid REVIEW/PASS and all security invariants remain true.

- [ ] **Step 7: If and only if acceptance is green, prepare integration review**

Run final branch comparison against the intended merge base, request code review, verify CI one more time, and only then decide how to integrate. Do not merge as part of this task automatically.

## Complete V1 Release Gate

`Chat2Codex Complete V1` becomes merge-eligible only when:

1. Browser Extension Relay Plan acceptance gate is green.
2. Remote MCP Transport Plan acceptance gate is green.
3. Complete local-stack E2E is green in CI.
4. Real Windows machine acceptance reaches `PLAN -> EXECUTED -> REVIEW -> DONE` with real ChatGPT and real Codex.
5. ChatGPT has no repository mutation tools and extension never transports repository content.
6. Main working tree remains unchanged by automatic tasks.
7. Browser/service-worker restart recovery does not duplicate logical transitions.
8. Remote MCP interruption cannot cause false PASS/DONE.
9. Node 20/22 CI is green at the exact accepted SHA.
