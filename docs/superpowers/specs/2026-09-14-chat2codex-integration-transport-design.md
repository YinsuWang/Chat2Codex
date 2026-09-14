# Chat2Codex V1 Integration Transport Design

Date: 2026-09-14  
Status: Proposed for implementation planning  
Base: Core V1 acceptance baseline `d5dd27752f568eaccbc15460c6d2a9ff32298dae`  
Branch: `feat/v1-integration-transport`

## 1. Purpose

Chat2Codex Core V1 has passed local execution acceptance: workspace registration, durable task state, isolated Git worktrees, real Codex CLI execution, execution evidence, read-only MCP tools, stale-base protection, workspace mismatch protection, and native Windows execution all work.

The remaining V1 gap is the ChatGPT integration path:

```text
ChatGPT
  -> read local workspace/evidence
  -> emit PLAN / REVIEW
  -> deliver control message to Supervisor
  -> receive EXECUTED
  -> inspect evidence
  -> REVIEW/PASS or REVIEW/REVISE
  -> DONE
```

The original V1 used Codex Desktop's built-in in-app browser (IAB) as the control relay. Real-machine acceptance showed that IAB tab/navigation operations can time out or lose stable tab state. This integration design removes IAB as a required dependency while preserving it as an experimental fallback.

## 2. Goals

V1 Integration Transport must:

1. Preserve the accepted Core V1 architecture and code paths.
2. Keep ChatGPT's repository access read-only.
3. Provide an authenticated remote path from ChatGPT to the local read-only MCP server without requiring a custom domain.
4. Provide an automatic Plus-compatible control relay that does not depend on Codex Desktop IAB.
5. Use a local Chromium extension as the default control surface for ChatGPT Web.
6. Keep control messages small and structured; repository files, diffs, and logs never travel through the extension.
7. Survive browser/service-worker restarts without losing Supervisor task state.
8. Support Windows first and Chrome/Edge first.
9. Retain manual CLI relay and Desktop IAB as recovery/fallback transports.
10. Avoid `danger-full-access`, public unauthenticated listeners, router port forwarding, or automatic merge/push.

## 3. Non-goals

The first integration release will not:

- publish the extension to Chrome Web Store or Edge Add-ons;
- support Firefox or Safari;
- automate ChatGPT account login, CAPTCHA, 2FA, or consent;
- automate ChatGPT connector settings through DOM automation;
- make ChatGPT an executor or expose write/shell/Git mutation MCP tools;
- carry repository file bodies, diffs, or command logs through the browser extension;
- provide multi-user/team relay hosting;
- auto-merge or auto-push task worktrees;
- require a purchased/custom domain;
- replace the already accepted `CodexCLIAdapter`, Supervisor state machine, task store, or execution recorder.

## 4. Key research conclusion

`XiaoDuoYa/codex-with-chatgpt` provides a useful proven reference for the **data plane**: loopback bridge, OAuth/PKCE, one-time pairing, workspace-bound credentials, and tunnel-provider abstraction.

It does **not** provide a reusable non-IAB control plane. Its current Skill explicitly uses the Codex Desktop built-in in-app browser to move control messages between ChatGPT and the local bridge.

Therefore Chat2Codex will reuse/adapt the security and tunnel patterns for read-only MCP, but will build a separate Chromium-extension control relay.

## 5. Target architecture

```text
                              ChatGPT Web
                                  |
                 +----------------+----------------+
                 |                                 |
          Read-only MCP                     Control messages
           Data Plane                             only
                 |                                 |
                 v                                 v
      Authenticated Remote MCP          Chromium Extension Relay
                 |                    (default ControlTransport)
                 |                                 |
                 v                                 v
         Loopback MCP Bridge              Loopback Relay Server
                 |                                 |
                 +----------------+----------------+
                                  |
                                  v
                             Supervisor
                                  |
                                  v
                             Codex CLI
                                  |
                                  v
                           Git task worktree
```

The two paths are intentionally independent. A failure in the browser relay must not change MCP permissions, and a tunnel failure must not change local execution permissions.

## 6. Core interfaces

The existing Core V1 `ControlTransport` contract remains the conceptual boundary:

```ts
export interface ControlTransport {
  publish(message: ControlMessage): Promise<ControlEnvelope>;
  receive(): Promise<ControlEnvelope | null>;
  acknowledge(id: string): Promise<void>;
}
```

The durable machine-local mailbox remains the Supervisor-side source of truth.

Integration adds two independent provider abstractions.

### 6.1 Remote MCP provider

```ts
export interface RemoteMcpProvider {
  readonly name: string;
  start(localPort: number): Promise<RemoteMcpEndpoint>;
  stop(): Promise<void>;
  status(): Promise<RemoteMcpStatus>;
  doctor(): Promise<RemoteMcpDoctorReport>;
}
```

`RemoteMcpEndpoint` exposes only the authenticated MCP endpoint metadata required for connector setup. It never contains project credentials in project files.

### 6.2 Browser relay provider

```ts
export interface RelayServer {
  start(): Promise<RelayRuntime>;
  stop(): Promise<void>;
  status(): Promise<RelayStatus>;
}
```

The Relay Server is loopback-only and speaks a small authenticated WebSocket protocol to the browser extension. It is not exposed through the public MCP tunnel.

## 7. Data plane: authenticated remote MCP

### 7.1 Local bridge remains unchanged

The existing MCP server continues to bind only to `127.0.0.1`. Its 12 read-only tools and all path/sensitive-data restrictions remain unchanged.

### 7.2 Remote exposure model

V1 supports a provider boundary rather than hard-coding one network vendor.

Providers, in priority order:

1. **External/Secure provider**: user or supported OpenAI environment supplies a secure remote path to the loopback MCP endpoint. Chat2Codex records health/endpoint metadata but does not own the external tunnel process.
2. **Cloudflare Quick Tunnel**: zero-domain development/default compatibility provider. It requires no purchased domain, but the URL is ephemeral and connector configuration may need to be refreshed after tunnel replacement.
3. **Cloudflare Named Tunnel**: optional stable provider for users who already own/control a domain and want a persistent endpoint. It is never mandatory.

The provider abstraction permits future Tailscale/ngrok/custom transports without touching MCP business logic.

### 7.3 Authentication model

When Chat2Codex itself exposes the MCP endpoint through a public tunnel, the public URL alone must not authorize reads.

V1 uses the same security shape proven by `codex-with-chatgpt`:

- OAuth-style authorization flow;
- PKCE S256 required;
- one-time short-lived pairing code for initial human pairing;
- high-entropy access and refresh tokens;
- persisted tokens stored only as hashes;
- access tokens bound to `workspace_id` and client identity;
- refresh-token rotation;
- scopes limited to read/search/git-read/execution-read/offline access;
- no write scope exists;
- unauthenticated `/mcp` requests return an authorization failure;
- bridge remains loopback-only behind the tunnel.

The implementation may reimplement or adapt MIT-licensed reference patterns, but Chat2Codex owns its own state format and tests.

### 7.4 ChatGPT product compatibility

ChatGPT cannot directly connect to localhost MCP; a remote or secure-tunnel path is required. Availability of custom/read-only MCP connection UI can vary by plan/product/workspace. Chat2Codex therefore treats connector availability as an integration prerequisite, not a reason to weaken the MCP server.

## 8. Control plane: Chromium Extension Relay

### 8.1 Browser/runtime support

V1 extension targets:

- Chrome 116+
- Microsoft Edge versions based on Chromium 116+
- Manifest V3

The minimum version is intentional: Chromium 116 improved extension-service-worker WebSocket lifetime behavior. The extension sends a keepalive frame at an interval shorter than 30 seconds while paired/active.

### 8.2 Extension components

```text
extension/
  manifest.json
  service-worker.ts
  content-script.ts
  chat-surface.ts
  popup/
    popup.html
    popup.ts
```

Responsibilities:

- **Service worker**: owns the authenticated loopback WebSocket, reconnect/backoff, pairing state, envelope delivery, acknowledgements, and deduplication metadata.
- **Content script**: runs only on `https://chatgpt.com/*`, observes the bound conversation, sends outbound control text into the composer, and detects assistant control blocks.
- **Chat surface adapter**: isolates all ChatGPT DOM-specific logic so UI changes do not infect protocol or WebSocket code.
- **Popup**: pairs/unpairs the local relay and binds the current ChatGPT tab to one workspace.

### 8.3 Least-privilege extension permissions

The extension requests only the permissions required for:

- execution on `https://chatgpt.com/*`;
- extension-local storage;
- active-tab/tab binding if required by the final Chromium API implementation;
- loopback relay communication.

It does not request cookies, browsing history, downloads, webRequest interception, debugger access, clipboard access, or broad `https://*/*` host access.

If Chromium requires explicit loopback host permission for the selected WebSocket implementation, it is limited to `127.0.0.1` rather than arbitrary network hosts.

## 9. Local relay authentication and pairing

The browser extension must not be trusted merely because it can reach localhost.

### 9.1 Pairing CLI

New commands:

```text
chat2codex relay pair -w <workspace> --json
chat2codex relay status -w <workspace> --json
chat2codex relay unpair -w <workspace> --json
```

`relay pair` creates a one-time random pairing code with:

- workspace binding;
- short TTL;
- limited attempts;
- one-time use;
- no project-file persistence.

The user enters the code in the extension popup.

### 9.2 Token exchange

Successful pairing exchanges the one-time code for a high-entropy relay token.

Server side:

- store only the token hash;
- bind it to `workspace_id` and paired extension identity/origin when available;
- state lives under the machine-local Chat2Codex state directory;
- state file permissions follow existing private-state policy.

Extension side:

- token is stored in `chrome.storage.local`, not synced storage;
- never exposed to the ChatGPT DOM/content-script world;
- service worker performs authentication to the relay server;
- unpair deletes local and server-side authorization.

### 9.3 WebSocket protocol

The relay endpoint binds only to loopback.

Unauthenticated connections receive no mailbox data. The first application message is an authentication handshake. After authentication, frames are schema-validated and workspace-bound.

Representative frame types:

```text
hello
hello_ok
keepalive
outbound_control
outbound_sent
assistant_control
assistant_ingested
relay_error
```

All control bodies remain subject to the existing 16 KiB protocol limit.

## 10. Conversation binding

V1 uses an explicit user binding gesture instead of guessing which ChatGPT tab belongs to which workspace.

The extension popup offers:

```text
Bind this ChatGPT tab to <workspace-name>
```

Rules:

1. One ChatGPT tab can bind to only one workspace at a time.
2. One workspace has at most one active bound ChatGPT tab in V1.
3. The binding is stored locally and includes workspace ID plus the current conversation URL/identity.
4. Navigation within the same bound conversation is tolerated.
5. Opening an unrelated ChatGPT tab does not receive Chat2Codex control messages.
6. Workspace mismatch stops relay immediately; it never rewrites the message to make it fit.

Multiple paired workspaces may exist on the machine, but only explicitly bound tabs participate.

## 11. Chat surface behavior

### 11.1 Sending Supervisor outbound messages

For an `EXECUTED` or other outbound envelope:

1. service worker receives the envelope from the local relay server;
2. it sends the envelope to the content script of the bound tab;
3. content script locates the ChatGPT composer through `ChatSurfaceAdapter`;
4. it inserts the exact formatted `[CHAT2CODEX]` text using DOM-safe text operations/events;
5. it submits once;
6. it returns `outbound_sent` with the envelope ID;
7. the server does **not** acknowledge the durable Supervisor outbound envelope yet.

### 11.2 Receiving ChatGPT assistant control messages

The content script observes assistant message blocks with `MutationObserver` plus a bounded rescan fallback.

It considers a block a control message only if its first line is exactly:

```text
[CHAT2CODEX]
```

The extracted block is sent to the service worker, then to the relay server. The server parses it through the existing protocol schema and validates `workspace_id`, `task_id`, and iteration rules.

Only after successful ingestion of the corresponding assistant control reply does the relay acknowledge the pending Supervisor outbound envelope.

### 11.3 Chat-first PLAN

A user may ask ChatGPT for a task before the Supervisor has emitted anything.

Therefore the content script also detects new assistant `[CHAT2CODEX] PLAN` blocks when no outbound envelope is pending. A valid, workspace-matching PLAN is ingested exactly once.

### 11.4 Deduplication

The extension and server both defend against duplication.

- Supervisor outbound uses durable envelope IDs.
- Extension tracks recently delivered envelope IDs.
- Assistant blocks are fingerprinted from normalized text plus workspace binding and stored in a bounded local dedupe cache.
- Server-side mailbox/protocol validation remains authoritative.
- Browser reconnect or service-worker restart may redeliver an unacknowledged envelope, but it must not create a second logical task transition.

## 12. ChatSurfaceAdapter boundary

ChatGPT Web DOM is not a stable public API. All DOM dependence is isolated behind:

```ts
export interface ChatSurfaceAdapter {
  isSupported(): Promise<boolean>;
  sendControlText(text: string): Promise<void>;
  observeAssistantControls(
    onControl: (text: string) => void,
  ): () => void;
  conversationIdentity(): Promise<string | null>;
}
```

The first implementation targets the current ChatGPT Web UI.

When the DOM changes and the adapter cannot establish a safe composer/message mapping, it must fail closed with `RELAY_UI_UNSUPPORTED`. It must not guess selectors and send into an unknown field.

## 13. Failure and recovery semantics

### Extension/service worker restart

- reconnect with bounded exponential backoff;
- reauthenticate from `chrome.storage.local`;
- request the next durable outbound envelope;
- do not infer prior send success if no corresponding assistant control was ingested.

### Browser tab closed

- relay status becomes `NO_BOUND_TAB`;
- Supervisor mailbox remains intact;
- no task state is changed merely because the browser disappeared.

### UI unsupported

- emit `RELAY_UI_UNSUPPORTED`;
- leave envelope unacknowledged;
- surface actionable status in extension popup and `chat2codex relay status`;
- manual CLI relay remains available for recovery.

### Remote MCP unavailable

- local Core remains operational;
- control relay may remain connected but ChatGPT cannot safely review evidence;
- full automatic workflow must not claim DONE from natural-language output alone.

### Duplicate or stale message

- schema/state-machine validation rejects it;
- relay records the error and preserves the current task state.

## 14. `chat2codex start` lifecycle

`chat2codex start` will own three local services under the existing daemon lock:

```text
Supervisor loop
Read-only MCP bridge
Browser relay server
```

Remote MCP tunnel/provider lifecycle is configurable:

- external providers may be managed outside the daemon;
- Chat2Codex-owned providers may start/stop with the daemon when explicitly configured.

A second `start` must be rejected before any bridge, relay server, or tunnel metadata can overwrite the running instance.

## 15. Doctor/status additions

`doctor` and `status` gain structured checks for:

- relay server listening on loopback;
- extension paired/not paired;
- bound tab heartbeat seen/not seen;
- relay token state valid/revoked;
- remote MCP provider configured;
- remote endpoint/tunnel health;
- local MCP authentication policy active;
- current integration blockers classified separately from Core failures.

Example classifications:

```text
REMOTE_MCP_NOT_CONFIGURED
REMOTE_MCP_UNHEALTHY
RELAY_NOT_PAIRED
NO_BOUND_TAB
RELAY_UI_UNSUPPORTED
CHATGPT_CONNECTOR_NOT_VERIFIED
```

These must not be reported as Codex execution failures.

## 16. Security invariants

The integration implementation must preserve all of the following:

1. ChatGPT still has no file-write, delete, shell, commit, push, install, or arbitrary-command tools.
2. The browser extension never reads repository files from disk.
3. Repository files/diffs/logs never travel over extension control frames.
4. The local relay binds only to loopback.
5. Public MCP exposure requires authentication; URL knowledge alone grants no workspace access.
6. Pairing credentials are short-lived and one-time.
7. Long-lived relay/OAuth tokens are never persisted raw by the local server.
8. Tokens are workspace-bound.
9. Content-script messages are treated as untrusted and revalidated by the service worker/server.
10. The extension uses text-safe DOM operations, never `eval` or untrusted `innerHTML`.
11. Prompt injection in repository content cannot grant new capabilities because the data plane remains read-only and the control plane accepts only protocol-schema messages.
12. Core worktree and stale-base protections remain unchanged.

## 17. Compatibility and migration

Existing Core V1 users keep all current behavior.

Control transports become:

```text
BrowserExtensionTransport  default automatic V1 transport
DesktopIabTransport         experimental fallback
ManualCliTransport          development/recovery fallback
```

The existing Desktop relay Skill remains in the repository but is relabeled experimental after the extension passes acceptance.

No persisted Core task format migration is required.

## 18. Proposed source layout

```text
extension/
  manifest.json
  src/
    service-worker.ts
    content-script.ts
    chat-surface.ts
    protocol.ts
    popup.ts

src/
  relay/
    server.ts
    auth.ts
    pairing.ts
    protocol.ts
    status.ts
  remote-mcp/
    provider.ts
    external.ts
  auth/
    oauth.ts
    token-store.ts
    pairing.ts
  tunnel/
    provider.ts
    cloudflare-quick.ts
    cloudflare-named.ts
    state.ts
  cli/commands/
    relay.ts
    tunnel.ts
```

Exact file splitting may be refined during implementation planning, but the module boundaries above are fixed: browser UI logic, local control relay, remote MCP auth, and tunnel process management remain separate.

## 19. Testing strategy

### Unit tests

- relay pairing TTL/attempts/one-time use;
- token hashing/revocation/workspace binding;
- relay frame schema validation;
- envelope and assistant-message dedupe;
- ChatSurfaceAdapter DOM fixtures;
- tunnel-provider state handling;
- OAuth/PKCE/token rotation;
- extension protocol serialization.

### Integration tests

- extension service worker <-> local WebSocket relay;
- reconnect/restart with pending durable envelope;
- chat-first PLAN ingestion;
- outbound EXECUTED -> assistant REVIEW correlation;
- wrong-workspace extension rejected;
- unpaired localhost client receives no mailbox data;
- remote MCP unauthenticated request rejected;
- authenticated remote MCP read succeeds and write tools remain absent.

### Browser tests

Use Chromium automation against a deterministic local ChatGPT-like fixture for most DOM relay tests. Real `chatgpt.com` is reserved for acceptance, not CI.

### Final machine acceptance

On the user's Windows machine:

```text
ChatGPT workspace_info through authenticated remote MCP
-> user asks task
-> assistant emits PLAN
-> Chrome/Edge extension ingests PLAN
-> Supervisor runs real Codex in isolated worktree
-> extension delivers EXECUTED
-> ChatGPT reads git_diff/execution_summary/test_status through MCP
-> assistant emits REVIEW/PASS or REVIEW/REVISE
-> Supervisor reaches DONE after PASS
```

Acceptance also verifies:

- one bound tab only;
- no duplicate PLAN/REVIEW on browser reconnect;
- main worktree unchanged;
- no MCP mutation tools;
- extension cannot access project files;
- relay survives extension service-worker restart;
- browser tab loss leaves durable state recoverable;
- remote MCP disconnect never silently marks a task DONE.

## 20. Release gate

`Chat2Codex Complete V1` is accepted only when all of the following pass:

1. Core V1 acceptance remains green.
2. Browser extension pairs and binds successfully on Chrome or Edge.
3. Authenticated remote read-only MCP works from the user's ChatGPT account/environment.
4. Full ChatGPT-first `PLAN -> EXECUTED -> REVIEW -> DONE` passes with real Codex execution.
5. Browser/service-worker restart recovery passes.
6. Security tests show no repository mutation capability in ChatGPT and no unauthenticated public MCP access.
7. Node 20/22 CI plus extension build/tests are green.

Until then, Core V1 remains accepted but Complete V1 remains pre-release.

## 21. Fixed design decisions

The following are now fixed for implementation planning:

- `d5dd27752f568eaccbc15460c6d2a9ff32298dae` is the frozen Core V1 baseline for this branch.
- Browser Extension Relay is the default automatic control transport.
- Codex Desktop IAB is fallback/experimental, not a required dependency.
- Extension targets Manifest V3 and Chromium 116+.
- Extension-to-local control uses an authenticated loopback WebSocket.
- User explicitly pairs the extension and explicitly binds a ChatGPT tab to a workspace.
- Project content never travels over the browser relay.
- Remote MCP and browser control transport are independent subsystems.
- No custom domain is mandatory.
- Cloudflare Quick Tunnel is the zero-domain compatibility provider; Named Tunnel is optional.
- Public MCP exposure is authenticated and workspace-bound.
- ChatGPT remains read-only with respect to the repository.
- Core Supervisor/Codex/worktree semantics are not redesigned in this phase.
