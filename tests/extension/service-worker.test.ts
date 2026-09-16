import { describe, expect, it, vi } from "vitest";
import {
  ExtensionRelayClient,
  EXTENSION_RELAY_STATE_KEY,
  reconnectDelayMs,
  type ExtensionRelayState,
  type RelaySocket,
  type RelayWorkerDependencies,
} from "../../extension/src/service-worker.js";

const NOW = "2026-09-16T10:00:00.000Z";
const STATE: ExtensionRelayState = {
  workspace_id: "ws_0123456789abcdef",
  workspace_name: "Fixture",
  relay_port: 48765,
  relay_token: "secret-token",
  extension_id: "ext-test",
  bound_tab_id: 42,
  conversation_id: "conversation-1",
};

class FakeSocket implements RelaySocket {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  send(data: string): void { this.sent.push(data); }
  close(): void { this.readyState = 3; this.onclose?.(); }
  open(): void { this.readyState = 1; this.onopen?.(); }
  message(frame: unknown): void { this.onmessage?.({ data: JSON.stringify(frame) }); }
}

function fixture(state: ExtensionRelayState | null = STATE) {
  const socket = new FakeSocket();
  const forwarded: Array<{ tabId: number; message: unknown }> = [];
  const statuses: string[] = [];
  const timers: Array<{ callback: () => void; delay: number; interval: boolean }> = [];
  const deps: RelayWorkerDependencies = {
    loadState: vi.fn(async () => state),
    createSocket: vi.fn((url) => { expect(url).toBe("ws://127.0.0.1:48765"); return socket; }),
    sendToTab: vi.fn(async (tabId, message) => { forwarded.push({ tabId, message }); }),
    publishStatus: vi.fn(async (status) => { statuses.push(status); }),
    setTimeout: vi.fn((callback, delay) => { timers.push({ callback, delay, interval: false }); return timers.length; }),
    clearTimeout: vi.fn(),
    setInterval: vi.fn((callback, delay) => { timers.push({ callback, delay, interval: true }); return timers.length; }),
    clearInterval: vi.fn(),
    now: () => new Date(NOW),
  };
  return { client: new ExtensionRelayClient(deps), socket, forwarded, statuses, timers, deps };
}

describe("extension relay service worker", () => {
  it("loads extension-local state and authenticates immediately after socket open", async () => {
    const { client, socket, deps } = fixture();
    await client.start();
    expect(deps.loadState).toHaveBeenCalledWith(EXTENSION_RELAY_STATE_KEY);
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toEqual({ type: "hello", workspace_id: STATE.workspace_id, token: STATE.relay_token, extension_id: STATE.extension_id });
  });

  it("starts a 20 second keepalive only after authentication", async () => {
    const { client, socket, timers } = fixture();
    await client.start();
    socket.open();
    expect(timers.filter((timer) => timer.interval)).toHaveLength(0);
    socket.message({ type: "hello_ok", workspace_id: STATE.workspace_id, server_time: NOW });
    await Promise.resolve();
    expect(timers.filter((timer) => timer.interval).map((timer) => timer.delay)).toEqual([20_000]);
    timers.find((timer) => timer.interval)!.callback();
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "keepalive", workspace_id: STATE.workspace_id, at: NOW });
  });

  it("uses bounded exponential reconnect delays", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(reconnectDelayMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("forwards each outbound envelope exactly once without exposing the token", async () => {
    const { client, socket, forwarded } = fixture();
    await client.start();
    socket.open();
    socket.message({ type: "hello_ok", workspace_id: STATE.workspace_id, server_time: NOW });
    await Promise.resolve();
    const frame = { type: "outbound_control", workspace_id: STATE.workspace_id, envelope_id: "env-1", text: "[CHAT2CODEX]\n{}" };
    socket.message(frame);
    socket.message(frame);
    await Promise.resolve();
    expect(forwarded).toEqual([{ tabId: 42, message: { type: "deliver_control", workspace_id: STATE.workspace_id, envelope_id: "env-1", text: frame.text } }]);
    expect(JSON.stringify(forwarded)).not.toContain(STATE.relay_token);
  });

  it("rejects wrong-workspace server frames and disconnects", async () => {
    const { client, socket, statuses } = fixture();
    await client.start();
    socket.open();
    socket.message({ type: "hello_ok", workspace_id: "ws_ffffffffffffffff", server_time: NOW });
    await Promise.resolve();
    expect(statuses).toContain("disconnected");
    expect(socket.readyState).toBe(3);
  });

  it("accepts only bound-tab messages and forwards validated frames", async () => {
    const { client, socket } = fixture();
    await client.start();
    socket.open();
    socket.message({ type: "hello_ok", workspace_id: STATE.workspace_id, server_time: NOW });
    await Promise.resolve();
    expect(client.handleContentMessage({ type: "outbound_sent", workspace_id: STATE.workspace_id, envelope_id: "env-1" }, 7)).toBe(false);
    expect(client.handleContentMessage({ type: "outbound_sent", workspace_id: STATE.workspace_id, envelope_id: "env-1" }, 42)).toBe(true);
    expect(JSON.parse(socket.sent.at(-1)!)).toEqual({ type: "outbound_sent", workspace_id: STATE.workspace_id, envelope_id: "env-1" });
  });

  it("restores persisted state after worker restart", async () => {
    const first = fixture();
    await first.client.start();
    first.client.stop();
    const second = fixture();
    await second.client.start();
    expect(second.deps.loadState).toHaveBeenCalledWith(EXTENSION_RELAY_STATE_KEY);
    expect(second.deps.createSocket).toHaveBeenCalledTimes(1);
  });
});
