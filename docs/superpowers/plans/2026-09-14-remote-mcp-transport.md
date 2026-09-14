# Remote MCP Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give ChatGPT authenticated remote access to Chat2Codex's existing read-only MCP data plane without exposing the loopback bridge directly, requiring a purchased domain, or adding any repository mutation capability.

**Architecture:** Keep the accepted local MCP bridge unchanged on `127.0.0.1`; add a second loopback-only authenticated MCP gateway that implements OAuth/PKCE and workspace-bound token scopes, then expose only that gateway through a pluggable remote provider. V1 ships an external-provider adapter plus Cloudflare Quick Tunnel; Named Tunnel is optional and isolated behind the same provider interface. The public URL alone never authorizes MCP reads.

**Tech Stack:** Node.js >=20, TypeScript 5.9+, Commander 14, Zod 4, MCP TypeScript SDK v2, Node `crypto/http/child_process`, Vitest 3.x, Cloudflare `cloudflared` executable for Chat2Codex-owned tunnel providers.

**Spec:** `docs/superpowers/specs/2026-09-14-chat2codex-integration-transport-design.md`

## Global Constraints

- Existing local MCP bridge and its 12 read-only tools remain unchanged in capability and loopback binding.
- Public exposure targets a separate authenticated gateway, never the unauthenticated local bridge directly.
- Unauthenticated public `/mcp` requests return authorization failure and no workspace content.
- OAuth flow requires PKCE S256; plain PKCE is rejected.
- Pairing/authorization code is one-time, short-lived, attempt-limited, and human-confirmed.
- Access tokens live 1 hour; refresh tokens live 30 days and rotate on every refresh.
- Server persists only token hashes, never raw access/refresh tokens.
- Tokens bind to `workspace_id`, client ID, and scopes.
- V1 scopes are exactly: `workspace.read`, `workspace.search`, `git.read`, `execution.read`, `offline_access`.
- No write/shell/delete/commit/push/install scope or tool exists.
- Remote providers are transport-only; they do not participate in authorization decisions.
- No router port forwarding or `0.0.0.0` listener.
- Quick Tunnel requires no purchased domain; Named Tunnel is optional.
- Core Supervisor/Codex/worktree/task behavior is not redesigned.

## File Structure

```text
src/auth/types.ts                         OAuth/token/client record types
src/auth/store.ts                         machine-local hash-only auth persistence
src/auth/pkce.ts                          verifier/challenge validation
src/auth/oauth.ts                         authorization/token/revoke/register service
src/auth/pairing.ts                       human authorization/pairing sessions
src/remote-mcp/gateway.ts                 authenticated loopback MCP/OAuth HTTP gateway
src/remote-mcp/runtime.ts                 gateway runtime metadata
src/remote-mcp/provider.ts                remote provider interface
src/remote-mcp/external.ts                externally-managed secure endpoint provider
src/tunnel/provider.ts                    Chat2Codex-owned tunnel interface
src/tunnel/state.ts                       per-workspace provider metadata
src/tunnel/cloudflare-quick.ts            zero-domain Quick Tunnel process manager
src/tunnel/cloudflare-named.ts            optional named-tunnel process manager
src/cli/commands/remote.ts                configure/start/status/stop remote MCP
src/cli/commands/tunnel.ts                provider-specific diagnostics/login hooks
src/cli/commands/start.ts                 optional remote provider lifecycle
src/cli/commands/status.ts                remote MCP status projection
src/cli/commands/doctor.ts                remote auth/tunnel checks
src/cli/index.ts                          command registration
tests/auth/*.test.ts                      OAuth/PKCE/token/pairing coverage
tests/remote-mcp/*.test.ts                authenticated gateway/provider coverage
tests/tunnel/*.test.ts                    tunnel parsing/process/state coverage
tests/e2e/remote-mcp.test.ts              auth + real MCP read integration
```

---

### Task 1: OAuth domain types, scopes, and hash-only auth store

**Files:**
- Create: `src/auth/types.ts`
- Create: `src/auth/store.ts`
- Test: `tests/auth/store.test.ts`

**Interfaces:**
- Produces:

```ts
export const MCP_READ_SCOPES = [
  "workspace.read",
  "workspace.search",
  "git.read",
  "execution.read",
  "offline_access",
] as const;

export type McpReadScope = typeof MCP_READ_SCOPES[number];

export interface OAuthClientRecord {
  client_id: string;
  redirect_uris: string[];
  created_at: string;
}

export interface TokenRecord {
  token_id: string;
  kind: "access" | "refresh";
  token_sha256: string;
  workspace_id: string;
  client_id: string;
  scopes: McpReadScope[];
  issued_at: string;
  expires_at: string;
  revoked_at: string | null;
  rotation_parent_id: string | null;
}

export class AuthStore {
  registerClient(client: OAuthClientRecord): Promise<void>;
  getClient(clientId: string): Promise<OAuthClientRecord | null>;
  putToken(record: TokenRecord): Promise<void>;
  verifyToken(rawToken: string, kind: TokenRecord["kind"]): Promise<TokenRecord | null>;
  revokeToken(tokenId: string): Promise<void>;
  revokeWorkspace(workspaceId: string): Promise<void>;
}
```

- [ ] **Step 1: Write failing store tests**

Cover:
- malformed workspace/client/scope records rejected;
- raw token never appears in persisted JSON;
- SHA-256 verification succeeds for correct token and fails for different token;
- expired/revoked token verifies as null;
- wrong token kind fails;
- workspace revoke invalidates all records in that workspace but not another workspace.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/auth/store.test.ts
```

Expected: module missing.

- [ ] **Step 3: Implement private state layout**

Persist under:

```text
<stateDir>/auth/clients/<client_id>.json
<stateDir>/auth/tokens/<token_id>.json
```

Validate identifiers before using them in paths. Use atomic temp-file + rename writes and file mode `0o600`.

- [ ] **Step 4: Implement hash-only token verification**

Token issuance helpers may return raw tokens to the caller once, but `AuthStore.putToken()` accepts only a hash-containing `TokenRecord`. Use timing-safe comparison when comparing fixed-length SHA-256 buffers.

- [ ] **Step 5: Run tests/typecheck**

```bash
pnpm vitest run tests/auth/store.test.ts
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/auth/types.ts src/auth/store.ts tests/auth/store.test.ts
git commit -m "feat: add remote MCP authorization store"
```

---

### Task 2: PKCE and one-time human pairing/authorization sessions

**Files:**
- Create: `src/auth/pkce.ts`
- Create: `src/auth/pairing.ts`
- Test: `tests/auth/pkce.test.ts`
- Test: `tests/auth/pairing.test.ts`

**Interfaces:**
- Produces:

```ts
export function verifyS256Pkce(verifier: string, challenge: string): boolean;

export interface AuthorizationSession {
  authorization_id: string;
  workspace_id: string;
  client_id: string;
  redirect_uri: string;
  scopes: McpReadScope[];
  code_challenge: string;
  state: string;
  pairing_code: string;
  expires_at: string;
  attempts_remaining: number;
  approved_at: string | null;
}

export class OAuthPairingService {
  create(input: Omit<AuthorizationSession, "authorization_id" | "pairing_code" | "expires_at" | "attempts_remaining" | "approved_at">): Promise<AuthorizationSession>;
  approve(pairingCode: string): Promise<AuthorizationSession>;
  consumeApproved(authorizationId: string): Promise<AuthorizationSession>;
}
```

- [ ] **Step 1: Write PKCE tests**

Use the RFC 7636 S256 example verifier/challenge and assert:
- correct S256 succeeds;
- wrong verifier fails;
- verifier outside 43–128 allowed unreserved characters is rejected;
- `plain` mode is not accepted anywhere.

- [ ] **Step 2: Write pairing tests**

Pairing session requirements:
- 8-character ambiguity-free code;
- 5-minute TTL;
- 5 attempts;
- approval is one-time;
- session binds exact client, redirect URI, workspace, scopes, challenge and state;
- expired session cannot be approved/consumed.

- [ ] **Step 3: Run RED**

```bash
pnpm vitest run tests/auth/pkce.test.ts tests/auth/pairing.test.ts
```

- [ ] **Step 4: Implement PKCE and session persistence**

Store active sessions under:

```text
<stateDir>/auth/authorizations/<authorization_id>.json
```

A short pairing code is the only credential intended for human entry. Delete the session after successful authorization-code exchange or terminal failure.

- [ ] **Step 5: Run tests/typecheck**

```bash
pnpm vitest run tests/auth/pkce.test.ts tests/auth/pairing.test.ts
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/auth/pkce.ts src/auth/pairing.ts tests/auth
git commit -m "feat: add PKCE and remote pairing sessions"
```

---

### Task 3: OAuth service with rotating refresh tokens

**Files:**
- Create: `src/auth/oauth.ts`
- Test: `tests/auth/oauth.test.ts`

**Interfaces:**
- Consumes: `AuthStore`, `OAuthPairingService`, `verifyS256Pkce()`.
- Produces:

```ts
export class OAuthService {
  registerClient(input: { redirect_uris: string[] }): Promise<OAuthClientRecord>;
  beginAuthorization(input: {
    workspace_id: string;
    client_id: string;
    redirect_uri: string;
    scopes: string[];
    code_challenge: string;
    code_challenge_method: "S256";
    state: string;
  }): Promise<AuthorizationSession>;
  exchangeAuthorizationCode(input: {
    code: string;
    client_id: string;
    redirect_uri: string;
    code_verifier: string;
  }): Promise<OAuthTokenResponse>;
  refresh(input: { refresh_token: string; client_id: string }): Promise<OAuthTokenResponse>;
  revoke(rawToken: string): Promise<void>;
  authorizeBearer(rawToken: string, workspaceId: string, requiredScopes: McpReadScope[]): Promise<TokenRecord>;
}
```

`OAuthTokenResponse`:

```ts
interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: 3600;
  refresh_token: string;
  scope: string;
}
```

- [ ] **Step 1: Write failing OAuth lifecycle tests**

Cover:
- dynamic client registration returns random client ID;
- unregistered redirect URI rejected;
- unknown/write scope rejected;
- S256 mandatory;
- authorization code one-time and 5-minute max age;
- access token 1 hour;
- refresh token 30 days;
- refresh rotates token and revokes old refresh immediately;
- replay of old refresh token fails;
- bearer token for workspace A returns workspace mismatch for B;
- insufficient scope rejected.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/auth/oauth.test.ts
```

- [ ] **Step 3: Implement authorization-code issuance**

After human pairing approval, generate a random single-use authorization code. Store its SHA-256 hash with exact session bindings and expiry; never persist raw code.

- [ ] **Step 4: Implement token issuance and refresh rotation**

Generate access/refresh values with at least 256 bits entropy. Persist hash records through `AuthStore`. Refresh transaction order must be:
1. verify old refresh;
2. issue/store replacement access + refresh;
3. revoke old refresh;
4. return raw replacements.

If step 2 fails, old refresh remains usable; if step 3 fails, fail closed and revoke both new records before returning an error.

- [ ] **Step 5: Implement bearer authorization**

`authorizeBearer()` checks token kind, expiry, revoke state, workspace equality, client binding and all required scopes. It never accepts refresh tokens as bearer access.

- [ ] **Step 6: Run tests/typecheck**

```bash
pnpm vitest run tests/auth/oauth.test.ts
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/auth/oauth.ts tests/auth/oauth.test.ts
git commit -m "feat: add OAuth token lifecycle for MCP"
```

---

### Task 4: Authenticated remote MCP gateway

**Files:**
- Create: `src/remote-mcp/runtime.ts`
- Create: `src/remote-mcp/gateway.ts`
- Test: `tests/remote-mcp/gateway.test.ts`

**Interfaces:**
- Consumes: existing `createChat2CodexMcpHandler()`, `OAuthService`, workspace record.
- Produces:

```ts
interface RemoteGatewayRuntimeState {
  workspace_id: string;
  host: "127.0.0.1";
  port: number;
  pid: number;
  started_at: string;
}

function startRemoteMcpGateway(options: {
  workspace: WorkspaceRecord;
  oauth: OAuthService;
  port?: number;
}): Promise<RemoteGatewayRuntime>;
```

- [ ] **Step 1: Write failing HTTP tests**

Test endpoints:

```text
GET  /.well-known/oauth-authorization-server
POST /oauth/register
GET  /oauth/authorize
POST /oauth/pair
POST /oauth/token
POST /oauth/revoke
POST|GET /mcp
GET /health
```

Security assertions:
- gateway binds only loopback;
- `/mcp` without bearer → 401 + `WWW-Authenticate`;
- wrong workspace token → 403;
- valid read token reaches MCP handler;
- health reveals product/version/workspace hash or ID policy from spec, but no absolute path/token;
- proxy headers such as `cf-connecting-ip` are acceptable on the public/tunnel-facing gateway because tunnel traffic arrives locally, but admin/pair approval endpoints must still require their explicit secret/code and never trust proxy IP for authorization.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/remote-mcp/gateway.test.ts
```

- [ ] **Step 3: Implement OAuth metadata and registration endpoints**

Metadata must advertise the runtime public issuer later supplied by provider configuration, authorization/token/registration/revocation endpoints, and S256 support only. Keep route generation isolated from process-global state so tests can supply deterministic issuer URLs.

- [ ] **Step 4: Implement authorization/pairing endpoints**

`GET /oauth/authorize` creates the server-side authorization session and returns a minimal HTML page instructing the user to enter/confirm its pairing code locally. `POST /oauth/pair` consumes the human code and redirects to the validated client redirect URI with authorization code + original state.

Do not render raw access/refresh tokens in HTML.

- [ ] **Step 5: Protect MCP by tool-scope map**

Before handing a request to the MCP node handler, validate bearer token at gateway level. Additionally provide token scopes to the MCP request context and enforce:

```ts
const TOOL_SCOPE: Record<string, McpReadScope> = {
  workspace_info: "workspace.read",
  list_directory: "workspace.read",
  read_file: "workspace.read",
  search_workspace: "workspace.search",
  git_status: "git.read",
  git_diff: "git.read",
  task_get: "execution.read",
  task_list: "execution.read",
  task_history: "execution.read",
  execution_summary: "execution.read",
  execution_output: "execution.read",
  test_status: "execution.read",
};
```

If the MCP SDK cannot expose per-tool auth context cleanly, enforce the superset of scopes at `/mcp` in V1 and document this as the implementation choice; do not add write scopes.

- [ ] **Step 6: Run gateway tests plus MCP regression**

```bash
pnpm vitest run tests/remote-mcp/gateway.test.ts tests/mcp
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/remote-mcp src/mcp tests/remote-mcp tests/mcp
git commit -m "feat: add authenticated remote MCP gateway"
```

---

### Task 5: Remote provider abstraction and external endpoint provider

**Files:**
- Create: `src/remote-mcp/provider.ts`
- Create: `src/remote-mcp/external.ts`
- Test: `tests/remote-mcp/provider.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RemoteMcpEndpoint {
  provider: string;
  public_url: string;
  mcp_url: string;
  issuer_url: string;
}

export interface RemoteMcpStatus {
  configured: boolean;
  running: boolean;
  endpoint: RemoteMcpEndpoint | null;
  detail: string | null;
}

export interface RemoteMcpProvider {
  readonly name: string;
  start(localPort: number): Promise<RemoteMcpEndpoint>;
  stop(): Promise<void>;
  status(): Promise<RemoteMcpStatus>;
  doctor(): Promise<{ ok: boolean; problems: string[] }>;
}
```

- [ ] **Step 1: Write failing provider tests**

External provider accepts a configured HTTPS base URL only. Reject:
- HTTP except explicit localhost test fixtures;
- URL with username/password;
- query/fragment;
- unsupported schemes.

It does not spawn any process. `start()` returns canonical `/mcp` and issuer URLs based on configured base.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/remote-mcp/provider.test.ts
```

- [ ] **Step 3: Implement provider interface/external adapter**

External provider state belongs in Chat2Codex machine state, not project files. It is a declaration that another authenticated secure tunnel maps the public URL to the local authenticated gateway.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/remote-mcp/provider.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/remote-mcp tests/remote-mcp/provider.test.ts
git commit -m "feat: add remote MCP provider boundary"
```

---

### Task 6: Tunnel provider/state boundary

**Files:**
- Create: `src/tunnel/provider.ts`
- Create: `src/tunnel/state.ts`
- Test: `tests/tunnel/state.test.ts`

**Interfaces:**
- Produces:

```ts
export interface TunnelStatus {
  running: boolean;
  url: string | null;
  provider: string;
  pid: number | null;
  detail: string | null;
}

export interface TunnelProvider {
  readonly name: string;
  start(localPort: number): Promise<string>;
  stop(): Promise<void>;
  status(): Promise<TunnelStatus>;
  doctor(): Promise<{ ok: boolean; problems: string[] }>;
}
```

- [ ] **Step 1: Write state tests**

Per-workspace tunnel metadata must live under:

```text
<stateDir>/tunnels/<workspace_id>.json
```

Validate provider name, HTTPS URL, pid, local port and timestamps. Runtime state with dead pid is reported stale rather than silently considered healthy.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/tunnel/state.test.ts
```

- [ ] **Step 3: Implement state helpers and interface**

Use atomic writes/mode `0o600`. Do not store cloud credentials or raw OAuth tokens in tunnel metadata.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/tunnel/state.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/tunnel tests/tunnel/state.test.ts
git commit -m "feat: define remote tunnel provider"
```

---

### Task 7: Cloudflare Quick Tunnel provider

**Files:**
- Create: `src/tunnel/cloudflare-quick.ts`
- Test: `tests/tunnel/cloudflare-quick.test.ts`
- Test fixture: `tests/fixtures/fake-cloudflared.mjs`

**Interfaces:**
- Consumes: `cloudflared` executable from PATH or `CHAT2CODEX_CLOUDFLARED_BIN`.
- Produces `CloudflareQuickTunnelProvider implements TunnelProvider`.

- [ ] **Step 1: Write fake process and failing parser/process tests**

Provider launches equivalent of:

```text
cloudflared tunnel --url http://127.0.0.1:<gateway-port> --no-autoupdate
```

Tests must prove:
- `shell:false`;
- only loopback target is constructed;
- public URL parsed only from `https://*.trycloudflare.com` output;
- timeout if no URL within 30 seconds;
- unexpected process exit fails startup;
- stop terminates owned process;
- stderr/log output is bounded and sanitized before persistence.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/tunnel/cloudflare-quick.test.ts
```

- [ ] **Step 3: Implement provider**

Use `spawn()` with argument array and `shell:false`. Reject `localPort` outside 1–65535. After URL discovery, persist runtime state. Never persist the random Quick Tunnel hostname as a credential; it is endpoint metadata only.

- [ ] **Step 4: Run tests/typecheck**

```bash
pnpm vitest run tests/tunnel/cloudflare-quick.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/cloudflare-quick.ts tests/tunnel/cloudflare-quick.test.ts tests/fixtures/fake-cloudflared.mjs
git commit -m "feat: add zero-domain Cloudflare Quick Tunnel"
```

---

### Task 8: Optional Cloudflare Named Tunnel provider

**Files:**
- Create: `src/tunnel/cloudflare-named.ts`
- Test: `tests/tunnel/cloudflare-named.test.ts`

**Interfaces:**
- Produces optional `CloudflareNamedTunnelProvider implements TunnelProvider`.
- Configuration references user-managed tunnel/hostname identifiers; secrets remain in cloudflared's own credential store, not Chat2Codex project/state JSON.

- [ ] **Step 1: Write failing configuration tests**

Require:
- stable HTTPS hostname;
- tunnel name/ID with conservative character validation;
- no inline Cloudflare token/secret accepted by Chat2Codex config;
- process command uses existing cloudflared login/credentials rather than raw secrets in argv.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/tunnel/cloudflare-named.test.ts
```

- [ ] **Step 3: Implement named provider**

Start equivalent of:

```text
cloudflared tunnel --no-autoupdate run <tunnel-name>
```

The provider health-checks configured public hostname against gateway `/health` or MCP OAuth metadata after startup. Do not provision DNS automatically in V1; document that named setup is optional/manual.

- [ ] **Step 4: Run tests**

```bash
pnpm vitest run tests/tunnel/cloudflare-named.test.ts
pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add src/tunnel/cloudflare-named.ts tests/tunnel/cloudflare-named.test.ts
git commit -m "feat: support optional named Cloudflare tunnel"
```

---

### Task 9: Remote MCP CLI, lifecycle, status, and doctor

**Files:**
- Create: `src/cli/commands/remote.ts`
- Create: `src/cli/commands/tunnel.ts`
- Modify: `src/cli/index.ts`
- Modify: `src/cli/commands/start.ts`
- Modify: `src/cli/commands/status.ts`
- Modify: `src/cli/commands/doctor.ts`
- Test: `tests/remote-mcp/cli.test.ts`
- Test: `tests/e2e/remote-start-order.test.ts`

**Interfaces:**
- CLI:

```text
chat2codex remote configure -w <workspace> --provider external --url <https-url> --json
chat2codex remote configure -w <workspace> --provider cloudflare-quick --json
chat2codex remote configure -w <workspace> --provider cloudflare-named --hostname <host> --tunnel <name> --json
chat2codex remote start -w <workspace> --json
chat2codex remote stop -w <workspace> --json
chat2codex remote status -w <workspace> --json
chat2codex remote pair -w <workspace> --json
chat2codex tunnel doctor -w <workspace> --json
```

- [ ] **Step 1: Write failing CLI tests**

Verify machine-local configuration, provider selection, pairing session output, stop/restart behavior, and no credential/project-file writes.

- [ ] **Step 2: Run RED**

```bash
pnpm vitest run tests/remote-mcp/cli.test.ts tests/e2e/remote-start-order.test.ts
```

- [ ] **Step 3: Implement configuration and provider factory**

Persist provider configuration under:

```text
<stateDir>/remote-mcp/<workspace_id>.json
```

Do not allow unknown provider names or raw secrets.

- [ ] **Step 4: Implement lifecycle**

`remote start` starts authenticated gateway first, then Chat2Codex-owned tunnel if configured. On tunnel failure, close gateway and leave no running metadata. External provider verifies declared endpoint but does not spawn a process.

`chat2codex start` may auto-start remote MCP only when workspace remote config explicitly has `auto_start: true`; default is false until the first successful connector acceptance.

- [ ] **Step 5: Extend status/doctor**

Add structured classifications:

```text
REMOTE_MCP_NOT_CONFIGURED
REMOTE_GATEWAY_STOPPED
REMOTE_PROVIDER_UNHEALTHY
REMOTE_MCP_AUTH_NOT_PAIRED
CHATGPT_CONNECTOR_NOT_VERIFIED
```

Do not mark Core Codex execution unhealthy for these integration states.

- [ ] **Step 6: Run focused/full tests**

```bash
pnpm vitest run tests/remote-mcp/cli.test.ts tests/e2e/remote-start-order.test.ts
pnpm test
pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/cli src/remote-mcp src/tunnel tests/remote-mcp tests/e2e/remote-start-order.test.ts
git commit -m "feat: manage authenticated remote MCP transport"
```

---

### Task 10: Authenticated remote MCP end-to-end and security regression

**Files:**
- Create: `tests/e2e/remote-mcp.test.ts`
- Create: `scripts/acceptance-remote-mcp.mjs`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/setup.md`
- Modify: `docs/troubleshooting.md`
- Modify: `README.md`

**Interfaces:**
- Uses real MCP client against authenticated gateway in-process; tunnel network itself is acceptance-tested on machine, not CI.

- [ ] **Step 1: Write E2E auth/read test**

Programmatically:
1. register workspace fixture;
2. start remote gateway;
3. register OAuth client;
4. begin authorization with S256;
5. approve pairing session;
6. exchange auth code;
7. connect MCP client with bearer;
8. call `workspace_info`, `read_file`, `git_diff`;
9. assert no mutation tools are listed;
10. refresh token, prove old refresh replay fails;
11. revoke and prove MCP returns 401.

- [ ] **Step 2: Add cross-workspace security test**

Token issued for workspace A against gateway B must return 403 before MCP tool invocation. Search/read must retain existing sensitive path restrictions.

- [ ] **Step 3: Add acceptance script**

`scripts/acceptance-remote-mcp.mjs --json` checks local gateway auth, provider health, OAuth metadata, unauthenticated `/mcp` rejection, and authenticated `workspace_info`. It must not print access/refresh tokens.

- [ ] **Step 4: Update docs**

Document three providers:
- external/secure tunnel where available;
- Cloudflare Quick Tunnel default zero-domain compatibility path;
- optional Named Tunnel.

Explicitly state Quick Tunnel URL can change and ChatGPT connector may need endpoint refresh/recreation; do not promise stable hostname.

- [ ] **Step 5: Run complete gate**

```bash
pnpm typecheck
pnpm test
pnpm build
node scripts/acceptance-remote-mcp.mjs --help
```

- [ ] **Step 6: Commit**

```bash
git add tests/e2e/remote-mcp.test.ts scripts/acceptance-remote-mcp.mjs .github/workflows/ci.yml docs README.md
git commit -m "test: verify authenticated remote MCP data plane"
```

## Plan 2 Acceptance Gate

Do not start the Complete V1 integration plan until:

1. OAuth/PKCE/token rotation tests pass.
2. Public-facing gateway rejects unauthenticated `/mcp` and wrong-workspace tokens.
3. Authenticated MCP E2E can read workspace/evidence and exposes no mutation tools.
4. Quick Tunnel provider starts/stops reliably on the user's Windows machine when `cloudflared` is available.
5. At least one ChatGPT-compatible authenticated remote endpoint is successfully configured during machine acceptance, or the blocker is classified as external product/integration availability rather than a Core failure.
6. Node 20/22 CI remains green.
