# Browser Extension Relay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Codex Desktop IAB as the default automatic ChatGPT control relay with an authenticated Chromium extension that moves only `[CHAT2CODEX]` control messages between one bound ChatGPT Web tab and the durable Supervisor mailbox.

**Architecture:** Add a loopback-only WebSocket relay server beside the existing Supervisor/MCP bridge, backed by machine-local pairing/token state and the existing durable mailbox. A Manifest V3 Chrome/Edge extension owns the loopback WebSocket in its service worker, keeps one ChatGPT tab explicitly bound to one workspace, and isolates all ChatGPT DOM behavior behind `ChatSurfaceAdapter`. Core Supervisor, Codex execution, worktrees, task persistence, and MCP tools remain unchanged.

**Tech Stack:** Node.js >=20, TypeScript 5.9+, Commander 14, Zod 4, `ws` 8.x, Vitest 3.x, Manifest V3, Chrome/Edge Chromium 116+, esbuild for extension bundling.

**Spec:** `docs/superpowers/specs/2026-09-14-chat2codex-integration-transport-design.md`

## Global Constraints

- Base behavior is Core V1 at `d5dd27752f568eaccbc15460c6d2a9ff32298dae`; do not redesign Supervisor/Codex/worktree semantics.
- Browser Extension Relay is the default automatic control transport; Desktop IAB remains experimental fallback.
- Relay server binds only to `127.0.0.1`; no public WebSocket listener.
- Every relay credential is workspace-bound; server persists only token hashes.
- Extension stores its relay token in `chrome.storage.local`, never sync storage.
- Extension only runs on `https://chatgpt.com/*` and never requests cookies, history, downloads, debugger, clipboard, broad `https://*/*`, or arbitrary network interception.
- Control message body limit remains 16 KiB and must reuse existing Chat2Codex control schemas.
- Repository files, diffs, logs, credentials, and command output never travel through relay frames.
- One ChatGPT tab binds to at most one workspace; one workspace has at most one active bound tab in V1.
- Content-script input is untrusted and must be revalidated by service worker/server.
- `RELAY_UI_UNSUPPORTED` fails closed; never guess selectors and send to an unknown field.
- Browser/service-worker restart may redeliver unacknowledged envelopes but must not create duplicate logical state transitions.
- No auto-merge or auto-push is introduced.

## File Structure

```text
package.json                              add ws/esbuild/browser build scripts
pnpm-lock.yaml                           regenerated from package changes
src/relay/protocol.ts                    relay frame schemas and limits
src/relay/pairing.ts                     one-time pairing state and token issuance
src/relay/token-store.ts                 token hashing/revocation/workspace binding
src/relay/server.ts                      loopback WebSocket server and mailbox bridge
src/relay/runtime.ts                     relay runtime metadata persistence
src/relay/status.ts                      typed relay health/status projection
src/cli/commands/relay.ts                pair/status/unpair CLI
src/cli/commands/start.ts                start relay under daemon lock
src/cli/commands/status.ts               include relay state
src/cli/commands/doctor.ts               classify relay integration blockers
src/cli/index.ts                         register relay CLI
extension/manifest.json                  MV3 permissions and content script declaration
extension/src/protocol.ts                browser-side relay frame types/validation helpers
extension/src/service-worker.ts          WebSocket lifecycle/auth/reconnect/dedupe
extension/src/content-script.ts          ChatGPT tab binding and assistant observation
extension/src/chat-surface.ts            all ChatGPT DOM selectors/operations
extension/src/popup.ts                   pair/unpair/bind user actions
extension/popup.html                     minimal local popup UI
extension/tsconfig.json                  browser-targeted TS config
scripts/build-extension.mjs              esbuild bundle/copy pipeline
tests/relay/*.test.ts                    server/pairing/protocol/status coverage
tests/extension/*.test.ts                browser protocol/chat-surface fixture coverage
tests/e2e/relay-mailbox.test.ts          durable mailbox relay integration
```

---

### Task 1: Relay protocol and dependency boundary

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `src/relay/protocol.ts`
- Test: `tests/relay/protocol.test.ts`

**Interfaces:**
- Consumes: existing `ControlEnvelope`, `ControlMessage`, `parseControlText()` and 16 KiB text framing limit.
- Produces: `RelayFrameSchema`, `RelayFrame`, `RelayClientFrame`, `RelayServerFrame`, `parseRelayFrame(text: string): RelayFrame`, `serializeRelayFrame(frame: RelayFrame): string`.

- [ ] **Step 1: Add the server/build dependencies**

Update `package.json` so production uses `ws` and extension builds use esbuild:

```json
{
  "scripts": {
    "build": "tsc -p tsconfig.json && node scripts/build-extension.mjs",
    "build:node": "tsc -p tsconfig.json",
    "build:extension": "node scripts/build-extension.mjs"
  },
  "dependencies": {
    "ws": "^8.18.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.0",
    "esbuild": "^0.25.0"
  }
}
```

Run:

```bash
pnpm install
```

Expected: lockfile updates without changing existing MCP/runtime dependency majors.

- [ ] **Step 2: Write failing relay protocol tests**

Create `tests/relay/protocol.test.ts` covering valid frames, >16 KiB body rejection, unknown frame rejection, malformed workspace IDs, and exact envelope IDs:

```ts
import { describe, expect, it } from "vitest";
import { parseRelayFrame, serializeRelayFrame } from "../../src/relay/protocol.js";

describe("relay protocol", () => {
  it("round-trips an authenticated assistant control frame", () => {
    const frame = {
      type: "assistant_control" as const,
      workspace_id: "ws_0123456789abcdef",
      text: "[CHAT2CODEX]\n{}",
      fingerprint: "sha256:abc",
    };
    expect(parseRelayFrame(serializeRelayFrame(frame))).toEqual(frame);
  });

  it("rejects oversized control text", () => {
    expect(() => parseRelayFrame(JSON.stringify({
      type: "assistant_control",
      workspace_id: "ws_0123456789abcdef",
      text: "x".repeat(16 * 1024 + 1),
      fingerprint: "sha256:abc",
    }))).toThrow(/RELAY_FRAME_TOO_LARGE|CONTROL_TEXT_TOO_LARGE/);
  });
});
```

- [ ] **Step 3: Run the test and confirm RED**

Run:

```bash
pnpm vitest run tests/relay/protocol.test.ts
```

Expected: FAIL because `src/relay/protocol.ts` does not exist.

- [ ] **Step 4: Implement the discriminated frame schema**

Implement `src/relay/protocol.ts` with Zod discriminated unions for exactly these frame types:

```ts
export type RelayClientFrame =
  | { type: "hello"; workspace_id: string; token: string; extension_id: string }
  | { type: "keepalive"; workspace_id: string; at: string }
  | { type: "outbound_sent"; workspace_id: string; envelope_id: string }
  | { type: "assistant_control"; workspace_id: string; text: string; fingerprint: string }
  | { type: "tab_heartbeat"; workspace_id: string; conversation_id: string };

export type RelayServerFrame =
  | { type: "hello_ok"; workspace_id: string; server_time: string }
  | { type: "outbound_control"; workspace_id: string; envelope_id: string; text: string }
  | { type: "assistant_ingested"; workspace_id: string; fingerprint: string }
  | { type: "relay_error"; code: string; detail: string };
```

Rules:
- workspace IDs use existing `ws_[a-f0-9]{16}` format;
- `text` max 16 KiB UTF-8 bytes, not character count;
- token max 256 characters and never appears in server frames;
- envelope IDs/fingerprints max 256 characters;
- JSON frame max 24 KiB total.

- [ ] **Step 5: Run protocol tests and typecheck**

Run:

```bash
pnpm vitest run tests/relay/protocol.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/relay/protocol.ts tests/relay/protocol.test.ts
git commit -m "feat: define browser relay protocol"
```

---

### Task 2: Workspace-bound pairing and relay token store

**Files:**
- Create: `src/relay/pairing.ts`
- Create: `src/relay/token-store.ts`
- Test: `tests/relay/pairing.test.ts`
- Test: `tests/relay/token-store.test.ts`

**Interfaces:**
- Consumes: `getStateDir()` and workspace ID format.
- Produces:

```ts
interface PairingSession {
  pairing_id: string;
  workspace_id: string;
  code: string;
  expires_at: string;
  attempts_remaining: number;
}

class RelayPairingService {
  create(workspaceId: string): Promise<PairingSession>;
  exchange(workspaceId: string, code: string, extensionId: string): Promise<{ token: string }>;
}

class RelayTokenStore {
  issue(workspaceId: string, extensionId: string): Promise<string>;
  verify(workspaceId: string, extensionId: string, rawToken: string): Promise<boolean>;
  revokeWorkspace(workspaceId: string): Promise<void>;
  status(workspaceId: string): Promise<{ paired: boolean; extension_id: string | null }>;
}
```

- [ ] **Step 1: Write failing pairing tests**

Cover:
- 8-character human code from an ambiguity-free uppercase alphabet;
- 5-minute TTL;
- max 5 failed attempts;
- code becomes unusable after exchange;
- wrong workspace cannot exchange;
- server state contains no raw long-lived token.

Representative test:

```ts
it("exchanges a pairing code once and stores only a token hash", async () => {
  const session = await pairing.create("ws_0123456789abcdef");
  const issued = await pairing.exchange(session.workspace_id, session.code, "ext-test");
  expect(issued.token.length).toBeGreaterThanOrEqual(43);
  await expect(pairing.exchange(session.workspace_id, session.code, "ext-test"))
    .rejects.toThrow(/PAIRING_CODE_INVALID|PAIRING_CODE_USED/);
  expect(await tokenStore.verify(session.workspace_id, "ext-test", issued.token)).toBe(true);
});
```

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm vitest run tests/relay/pairing.test.ts tests/relay/token-store.test.ts
```

Expected: missing-module failures.

- [ ] **Step 3: Implement token storage**

Use `randomBytes(32).toString("base64url")` for raw relay tokens and SHA-256 for persisted token hashes. Persist under:

```text
<stateDir>/relay/<workspace_id>/authorization.json
```

Persist only:

```ts
interface RelayAuthorizationRecord {
  workspace_id: string;
  extension_id: string;
  token_sha256: string;
  issued_at: string;
  revoked_at: string | null;
}
```

Write atomically with mode `0o600`. Reject malformed persisted records instead of repairing them silently.

- [ ] **Step 4: Implement pairing state**

Persist active pairing session under the same workspace relay directory with mode `0o600`. Expired sessions are deleted on read/exchange. Hash or remove the pairing code immediately after successful exchange; no reusable plaintext credential remains.

- [ ] **Step 5: Run tests and typecheck**

```bash
pnpm vitest run tests/relay/pairing.test.ts tests/relay/token-store.test.ts
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/relay/pairing.ts src/relay/token-store.ts tests/relay
git commit -m "feat: add workspace-bound relay pairing"
```

---

### Task 3: Loopback WebSocket relay server

**Files:**
- Create: `src/relay/runtime.ts`
- Create: `src/relay/server.ts`
- Create: `src/relay/status.ts`
- Test: `tests/relay/server.test.ts`
- Test: `tests/relay/runtime.test.ts`

**Interfaces:**
- Consumes: `ControlService`, `RelayTokenStore`, relay frame parser, workspace record.
- Produces:

```ts
interface RelayRuntimeState {
  workspace_id: string;
  host: "127.0.0.1";
  port: number;
  pid: number;
  started_at: string;
}

interface RelayRuntime extends RelayRuntimeState {
  close(): Promise<void>;
}

function startRelayServer(options: {
  workspaceId: string;
  controlService: ControlService;
  tokenStore?: RelayTokenStore;
  port?: number;
}): Promise<RelayRuntime>;

function getRelayRuntime(workspaceId: string): Promise<RelayRuntimeState | null>;
```

- [ ] **Step 1: Write failing WebSocket integration tests**

Use a real `ws` client. Cover:
- server only binds `127.0.0.1`;
- unauthenticated client gets no outbound mailbox data;
- wrong workspace/token receives `relay_error` then closes;
- authenticated client receives next outbound envelope as exact formatted control text;
- `assistant_control` calls existing `ControlService.ingest()`;
- duplicate assistant fingerprint gets one `assistant_ingested` outcome without a duplicate task transition;
- pending outbound envelope is not acknowledged on `outbound_sent` alone.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm vitest run tests/relay/server.test.ts tests/relay/runtime.test.ts
```

- [ ] **Step 3: Implement runtime metadata**

Mirror the bridge runtime discipline using:

```text
<stateDir>/runtime/<workspace_id>-relay.json
```

Validate host, port, pid, workspace ID, and started timestamp on read. Remove runtime metadata only if closing instance still owns the saved pid/port.

- [ ] **Step 4: Implement authenticated connection state machine**

Each socket starts `UNAUTHENTICATED`. Only `hello` is accepted before authentication. After token verification, store connection context:

```ts
interface RelayConnectionContext {
  workspace_id: string;
  extension_id: string;
  authenticated: true;
  last_heartbeat_at: string | null;
  conversation_id: string | null;
}
```

Reject binary WebSocket frames and frames over 24 KiB before JSON parsing.

- [ ] **Step 5: Bridge the durable mailbox without changing Supervisor state**

On authenticated `keepalive`/initial hello, call `controlService.receiveOutbound()` (or the existing exact next-outbound method). Send at most one durable envelope at a time. Do not delete/ack it on network send success.

On valid `assistant_control`:
1. parse `[CHAT2CODEX]` through the existing protocol parser;
2. enforce workspace equality;
3. ingest through `ControlService`;
4. acknowledge the corresponding outbound envelope only after successful assistant ingestion when one is pending;
5. return `assistant_ingested`.

For chat-first PLAN with no pending outbound envelope, ingest the PLAN and return `assistant_ingested` without acknowledging anything.

- [ ] **Step 6: Add bounded dedupe storage**

Keep a per-workspace disk-backed cache of the most recent 128 assistant fingerprints under relay state. Fingerprint replay returns successful `assistant_ingested` but does not reinvoke ingestion. Use atomic writes and cap serialized size.

- [ ] **Step 7: Run server tests and full Core regression**

```bash
pnpm vitest run tests/relay/server.test.ts tests/relay/runtime.test.ts
pnpm test
pnpm typecheck
```

Expected: all existing Core tests remain green.

- [ ] **Step 8: Commit**

```bash
git add src/relay tests/relay
git commit -m "feat: add authenticated loopback relay server"
```

---

### Task 4: Relay CLI and daemon lifecycle

**Files:**
- Create: `src/cli/commands/relay.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/relay/cli.test.ts`
- Test: `tests/e2e/start-relay-order.test.ts`

**Interfaces:**
- Consumes: pairing/token/runtime services and existing daemon `onAcquired` lifecycle.
- Produces CLI:

```text
chat2codex relay pair -w <workspace> --json
chat2codex relay status -w <workspace> --json
chat2codex relay unpair -w <workspace> --json
```

- [ ] **Step 1: Write failing CLI/lifecycle tests**

Assertions:
- `relay pair --json` returns workspace ID, pairing code, expiry but never raw long-lived token;
- `relay status --json` returns `paired`, `relay_running`, `bound_tab_seen`, `last_heartbeat_at`;
- `relay unpair` revokes current token;
- `start` obtains daemon lock before starting both MCP bridge and relay server;
- second `start` cannot overwrite bridge or relay runtime metadata;
- cleanup closes relay and bridge even if Supervisor loop exits with an error.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm vitest run tests/relay/cli.test.ts tests/e2e/start-relay-order.test.ts
```

- [ ] **Step 3: Implement `relay` command group**

Register subcommands in `src/cli/index.ts`. Human output may show the short pairing code; JSON output is canonical for automation.

- [ ] **Step 4: Start relay under the existing daemon lock**

Modify the existing `onAcquired` callback so it starts bridge then relay and returns one cleanup closure:

```ts
const bridge = await startBridge({ workspace });
const relay = await startRelayServer({
  workspaceId: workspace.workspace_id,
  controlService: supervisor.controlService,
});
return async () => {
  await relay.close();
  await bridge.close();
};
```

If relay startup fails after bridge startup, close the bridge before rethrowing.

- [ ] **Step 5: Extend status/doctor classification**

`status --json` adds:

```ts
relay: {
  host: "127.0.0.1";
  port: number;
  pid: number;
  paired: boolean;
  bound_tab_seen: boolean;
  last_heartbeat_at: string | null;
} | null
```

`doctor` adds checks named `relay_server`, `relay_pairing`, and `relay_tab`. A missing pair/tab is an integration blocker with an explicit detail; do not label Codex/Core unhealthy.

- [ ] **Step 6: Run focused and full tests**

```bash
pnpm vitest run tests/relay/cli.test.ts tests/e2e/start-relay-order.test.ts
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/cli src/relay tests/relay tests/e2e/start-relay-order.test.ts
git commit -m "feat: integrate relay lifecycle and CLI"
```

---

### Task 5: Extension build skeleton and least-privilege manifest

**Files:**
- Create: `extension/manifest.json`
- Create: `extension/tsconfig.json`
- Create: `extension/src/protocol.ts`
- Create: `extension/src/service-worker.ts`
- Create: `extension/src/content-script.ts`
- Create: `extension/src/chat-surface.ts`
- Create: `extension/src/popup.ts`
- Create: `extension/popup.html`
- Create: `scripts/build-extension.mjs`
- Test: `tests/extension/manifest.test.ts`
- Test: `tests/extension/build.test.ts`

**Interfaces:**
- Consumes: JSON relay frame contract from Task 1, duplicated as browser-safe types/schema constants without importing Node-only modules.
- Produces: unpacked extension artifact under `dist-extension/`.

- [ ] **Step 1: Write failing manifest/build tests**

Test that manifest:
- `manifest_version === 3`;
- host permissions are exactly `https://chatgpt.com/*` plus loopback only if Chromium requires it;
- permissions do not contain `cookies`, `history`, `downloads`, `debugger`, `clipboardRead`, `clipboardWrite`, `webRequest`;
- service worker and content script bundle files exist after build;
- extension output contains no Node builtins.

- [ ] **Step 2: Run tests and confirm RED**

```bash
pnpm vitest run tests/extension/manifest.test.ts tests/extension/build.test.ts
```

- [ ] **Step 3: Create the MV3 manifest**

Use:

```json
{
  "manifest_version": 3,
  "name": "Chat2Codex Relay",
  "version": "0.1.0",
  "minimum_chrome_version": "116",
  "permissions": ["storage", "tabs"],
  "host_permissions": ["https://chatgpt.com/*"],
  "background": { "service_worker": "service-worker.js", "type": "module" },
  "content_scripts": [{
    "matches": ["https://chatgpt.com/*"],
    "js": ["content-script.js"],
    "run_at": "document_idle"
  }],
  "action": { "default_popup": "popup.html" }
}
```

Do not add loopback host permission unless an actual Chrome runtime test proves WebSocket requires it; WebSocket connections are not controlled by `host_permissions` in the same way as fetch/XHR.

- [ ] **Step 4: Implement deterministic esbuild bundling**

`scripts/build-extension.mjs` must clean and recreate `dist-extension/`, bundle three entry points (`service-worker`, `content-script`, `popup`) targeting Chrome 116, copy manifest/popup HTML, and fail on warnings that indicate unresolved Node builtins.

- [ ] **Step 5: Add minimal compile-safe entry points**

Each entry point should only initialize its own component and log no credentials/control bodies. `extension/src/protocol.ts` exports frame type guards needed by service worker.

- [ ] **Step 6: Run extension build tests**

```bash
pnpm build:extension
pnpm vitest run tests/extension/manifest.test.ts tests/extension/build.test.ts
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add extension scripts package.json pnpm-lock.yaml tests/extension
git commit -m "feat: scaffold Chat2Codex browser extension"
```

---

### Task 6: Extension service-worker WebSocket client

**Files:**
- Modify: `extension/src/service-worker.ts`
- Modify: `extension/src/protocol.ts`
- Test: `tests/extension/service-worker.test.ts`

**Interfaces:**
- Consumes: relay URL/port, workspace ID, token and extension identity from `chrome.storage.local`.
- Produces internal messages to content script:

```ts
{ type: "deliver_control"; workspace_id: string; envelope_id: string; text: string }
{ type: "relay_status"; state: "connected" | "disconnected" | "auth_failed" }
```

- [ ] **Step 1: Write failing service-worker tests with mocked Chrome/WebSocket**

Cover:
- sends `hello` immediately after socket open;
- never sends token to content script;
- sends keepalive every 20 seconds only while socket is open/authenticated;
- reconnect backoff sequence 1s, 2s, 4s, 8s, capped at 30s;
- receives `outbound_control` and forwards exactly once to bound tab;
- restart reloads token/binding from local storage;
- wrong-workspace server frame is dropped and status becomes error.

- [ ] **Step 2: Run test and confirm RED**

```bash
pnpm vitest run tests/extension/service-worker.test.ts
```

- [ ] **Step 3: Implement storage model**

Use one record:

```ts
interface ExtensionRelayState {
  workspace_id: string;
  workspace_name: string;
  relay_port: number;
  relay_token: string;
  extension_id: string;
  bound_tab_id: number | null;
  conversation_id: string | null;
}
```

Store under a fixed extension-local key. Never use `chrome.storage.sync`.

- [ ] **Step 4: Implement WebSocket lifecycle**

Connect only to:

```text
ws://127.0.0.1:<validated-port>
```

Reject any stored host value other than loopback; only the port is persisted. Authenticate with `hello`, then start 20-second keepalive. Clear timers on close and reconnect with bounded backoff.

- [ ] **Step 5: Implement bound-tab forwarding and acknowledgements**

Forward `outbound_control` only to `bound_tab_id`. Accept from content script only `outbound_sent`, `assistant_control`, and `tab_heartbeat`, validate workspace/bound tab sender ID, then serialize to server.

- [ ] **Step 6: Run tests and extension build**

```bash
pnpm vitest run tests/extension/service-worker.test.ts
pnpm build:extension
```

- [ ] **Step 7: Commit**

```bash
git add extension/src/service-worker.ts extension/src/protocol.ts tests/extension/service-worker.test.ts
git commit -m "feat: connect extension relay service worker"
```

---

### Task 7: ChatSurfaceAdapter and safe ChatGPT DOM relay

**Files:**
- Modify: `extension/src/chat-surface.ts`
- Modify: `extension/src/content-script.ts`
- Test: `tests/extension/chat-surface.test.ts`
- Test fixtures: `tests/extension/fixtures/chatgpt-chat.html`

**Interfaces:**
- Produces exact spec interface:

```ts
export interface ChatSurfaceAdapter {
  isSupported(): Promise<boolean>;
  sendControlText(text: string): Promise<void>;
  observeAssistantControls(onControl: (text: string) => void): () => void;
  conversationIdentity(): Promise<string | null>;
}
```

- [ ] **Step 1: Create a deterministic ChatGPT-like DOM fixture**

Fixture must include:
- one composer contenteditable/textarea-compatible surface;
- one submit button;
- user and assistant message containers with stable test-only attributes matching the adapter's semantic lookup strategy;
- unrelated editable fields to prove fail-closed behavior.

- [ ] **Step 2: Write failing adapter tests**

Cover:
- `isSupported()` true only when exactly one safe composer + send control can be identified;
- false/`RELAY_UI_UNSUPPORTED` for ambiguous or missing composer;
- `sendControlText()` uses text/value assignment + input events, never `innerHTML`;
- text is submitted once;
- observer only emits assistant blocks whose first line is exactly `[CHAT2CODEX]`;
- observer ignores user messages and prose containing the marker later in the text;
- conversation identity derives from current `/c/<id>` URL when present and otherwise returns null.

- [ ] **Step 3: Run tests and confirm RED**

```bash
pnpm vitest run tests/extension/chat-surface.test.ts
```

- [ ] **Step 4: Implement semantic selector strategy**

Prefer accessibility/role/data-testid semantics present on the current ChatGPT surface, with a small ordered list in one file. Never use positional selectors such as `div:nth-child(...)`. Require an unambiguous composer + send action before returning supported.

- [ ] **Step 5: Implement exact-text sending**

Reject text over 16 KiB before DOM work. Preserve newlines exactly. Dispatch the minimum input/change events necessary for React to observe the value, then click/activate the validated send action exactly once.

- [ ] **Step 6: Implement assistant observation**

Use `MutationObserver` and a bounded full rescan (max 200 message nodes) after each relevant mutation. Deduplicate within the content script by a SHA-256-compatible fingerprint delegated to service worker if Web Crypto availability differs in test/runtime.

- [ ] **Step 7: Connect content script to service worker**

On `deliver_control`, confirm current tab is supported and conversation identity matches the bound conversation when one is saved. Send exact text, then reply `outbound_sent`. Start assistant observer and send valid assistant controls upstream with conversation heartbeat.

- [ ] **Step 8: Run adapter tests/build**

```bash
pnpm vitest run tests/extension/chat-surface.test.ts
pnpm build:extension
```

- [ ] **Step 9: Commit**

```bash
git add extension/src/content-script.ts extension/src/chat-surface.ts tests/extension
git commit -m "feat: relay control messages through ChatGPT Web"
```

---

### Task 8: Extension pairing popup and explicit tab/workspace binding

**Files:**
- Modify: `extension/src/popup.ts`
- Modify: `extension/popup.html`
- Modify: `extension/src/service-worker.ts`
- Test: `tests/extension/popup.test.ts`

**Interfaces:**
- User provides: relay port, workspace ID, one-time pairing code.
- Popup actions: `pair`, `bind current tab`, `unbind`, `unpair`.

- [ ] **Step 1: Write failing popup state tests**

Test four states:

```text
UNPAIRED
PAIRED_NO_TAB
PAIRED_BOUND
ERROR
```

Ensure popup never displays the raw long-lived token and refuses to bind a non-`chatgpt.com` tab.

- [ ] **Step 2: Run test and confirm RED**

```bash
pnpm vitest run tests/extension/popup.test.ts
```

- [ ] **Step 3: Add local pairing HTTP endpoint to relay server**

Add one loopback-only endpoint separate from WebSocket, e.g.:

```text
POST http://127.0.0.1:<relay-port>/pair
```

Request body:

```json
{
  "workspace_id": "ws_0123456789abcdef",
  "code": "ABCDEFGH",
  "extension_id": "generated-extension-identity"
}
```

Response only on successful one-time exchange:

```json
{ "workspace_id": "...", "token": "..." }
```

Reject proxy headers and non-loopback remote addresses. Add server tests for rate/attempt/TTL behavior through the HTTP surface.

- [ ] **Step 4: Implement popup pair flow**

Popup POSTs to loopback using user-entered port/workspace/code, then sends the returned token directly to service worker for `chrome.storage.local`. It never writes token into DOM after success.

- [ ] **Step 5: Implement explicit current-tab binding**

Use `chrome.tabs.query({ active: true, currentWindow: true })`; require URL host `chatgpt.com`. Ask content script for `conversationIdentity()`. Save tab ID + conversation ID. Binding another tab replaces previous binding only after user clicks the bind action.

- [ ] **Step 6: Implement unpair**

Popup asks local server to revoke workspace authorization using the authenticated WebSocket/control path or a dedicated loopback endpoint requiring the current relay token, then clears local storage.

- [ ] **Step 7: Run tests/build**

```bash
pnpm vitest run tests/extension/popup.test.ts tests/relay/server.test.ts
pnpm build:extension
```

- [ ] **Step 8: Commit**

```bash
git add extension src/relay tests/extension tests/relay
git commit -m "feat: pair and bind Chat2Codex extension"
```

---

### Task 9: Durable mailbox end-to-end relay integration

**Files:**
- Create: `tests/e2e/relay-mailbox.test.ts`
- Modify: `src/relay/server.ts` only if test exposes protocol gap
- Modify: `src/control/service.ts` only if an existing public method is insufficient; preserve current mailbox semantics

**Interfaces:**
- Uses real `ControlService` durable inbox/outbox and a real WebSocket client simulating the extension.

- [ ] **Step 1: Write end-to-end test for chat-first PLAN**

Flow:

```text
assistant_control(PLAN)
→ relay server
→ ControlService ingest
→ TaskStore PLANNED
```

Reconnect and replay the same fingerprint; task must remain one logical PLAN transition.

- [ ] **Step 2: Write end-to-end test for EXECUTED/REVIEW correlation**

Seed one outbound `EXECUTED` envelope. Authenticate extension, receive it, report `outbound_sent`, disconnect, reconnect: envelope must be redelivered. Then send matching assistant `REVIEW/PASS`; only then should durable outbound be acknowledged and inbound review be available to Supervisor.

- [ ] **Step 3: Write service-worker restart/replay test**

Simulate extension restart by discarding client-side memory while preserving token/binding storage. Reconnect and verify exactly-once logical task transition despite at-least-once network delivery.

- [ ] **Step 4: Run E2E and all Core tests**

```bash
pnpm vitest run tests/e2e/relay-mailbox.test.ts
pnpm test
pnpm typecheck
pnpm build
```

- [ ] **Step 5: Commit**

```bash
git add tests/e2e/relay-mailbox.test.ts src/relay src/control
git commit -m "test: verify durable browser relay semantics"
```

---

### Task 10: Relay documentation, packaging, and acceptance script

**Files:**
- Modify: `README.md`
- Modify: `docs/setup.md`
- Modify: `docs/troubleshooting.md`
- Modify: `skill/SKILL.md`
- Create: `docs/extension-install.md`
- Create: `scripts/acceptance-relay.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Documents Browser Extension Relay as default; Desktop IAB as experimental fallback.

- [ ] **Step 1: Add CI extension build/test gate**

CI must run on Node 20 and 22:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

and explicitly assert these artifacts exist:

```text
dist-extension/manifest.json
dist-extension/service-worker.js
dist-extension/content-script.js
dist-extension/popup.js
```

- [ ] **Step 2: Write extension installation instructions**

Document Chrome and Edge unpacked-extension installation, pairing command, popup binding, status interpretation, and unpair. Do not instruct users to enable dangerous browser debugging flags.

- [ ] **Step 3: Relabel Desktop IAB Skill**

At the top of `skill/SKILL.md`, state that it is an experimental/recovery transport. Do not delete it because it remains a fallback.

- [ ] **Step 4: Add relay acceptance script**

`scripts/acceptance-relay.mjs` should validate local-only prerequisites without automating ChatGPT Web:
- registered workspace;
- daemon + bridge + relay running;
- extension paired heartbeat observed;
- read-only tool count unchanged;
- no main-worktree mutation.

Exit nonzero for local relay failures and print JSON when `--json` is provided.

- [ ] **Step 5: Run complete local gate**

```bash
pnpm typecheck
pnpm test
pnpm build
node bin/chat2codex.js --help
node scripts/acceptance-relay.mjs --help
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add README.md docs skill scripts .github/workflows/ci.yml
git commit -m "docs: make browser relay the default control transport"
```

## Plan 1 Acceptance Gate

Do not start the Remote MCP implementation plan until all of these are true:

1. Node 20/22 CI is green.
2. Relay server binds only loopback and rejects unpaired clients.
3. Extension can be loaded unpacked in current Chrome/Edge.
4. Extension can pair, bind one ChatGPT tab, and maintain a heartbeat through service-worker restart.
5. Local deterministic ChatGPT-like browser fixture proves send/observe behavior and duplicate resistance.
6. Durable mailbox E2E proves chat-first PLAN and EXECUTED→REVIEW correlation.
7. Core V1 tests remain green and main project worktree semantics are unchanged.
