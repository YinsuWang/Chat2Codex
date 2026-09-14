import { describe, expect, it } from "vitest";

import {
  parseRelayFrame,
  serializeRelayFrame,
} from "../../src/relay/protocol.js";

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

  it("round-trips an outbound envelope without changing its id", () => {
    const frame = {
      type: "outbound_control" as const,
      workspace_id: "ws_0123456789abcdef",
      envelope_id: "env_01HZZZZZZZZZZZZZZZZZZZZZZZ",
      text: "[CHAT2CODEX]\n{}",
    };

    const parsed = parseRelayFrame(serializeRelayFrame(frame));
    expect(parsed).toEqual(frame);
    expect(parsed.type === "outbound_control" && parsed.envelope_id).toBe(frame.envelope_id);
  });

  it("rejects oversized control text by UTF-8 byte count", () => {
    expect(() =>
      parseRelayFrame(
        JSON.stringify({
          type: "assistant_control",
          workspace_id: "ws_0123456789abcdef",
          text: "界".repeat(Math.floor((16 * 1024) / 3) + 1),
          fingerprint: "sha256:abc",
        }),
      ),
    ).toThrow(/RELAY_FRAME_TOO_LARGE|CONTROL_TEXT_TOO_LARGE/);
  });

  it("rejects unknown frame types", () => {
    expect(() =>
      parseRelayFrame(
        JSON.stringify({
          type: "run_shell",
          workspace_id: "ws_0123456789abcdef",
        }),
      ),
    ).toThrow();
  });

  it("rejects unknown fields instead of silently stripping them", () => {
    expect(() =>
      parseRelayFrame(
        JSON.stringify({
          type: "outbound_control",
          workspace_id: "ws_0123456789abcdef",
          envelope_id: "env_01HZZZZZZZZZZZZZZZZZZZZZZZ",
          text: "[CHAT2CODEX]\n{}",
          token: "must-not-be-accepted-on-server-frames",
        }),
      ),
    ).toThrow();
  });

  it("rejects malformed workspace ids", () => {
    expect(() =>
      parseRelayFrame(
        JSON.stringify({
          type: "keepalive",
          workspace_id: "workspace-1",
          at: new Date().toISOString(),
        }),
      ),
    ).toThrow();
  });

  it("rejects relay tokens longer than 256 characters", () => {
    expect(() =>
      parseRelayFrame(
        JSON.stringify({
          type: "hello",
          workspace_id: "ws_0123456789abcdef",
          token: "t".repeat(257),
          extension_id: "extension-1",
        }),
      ),
    ).toThrow();
  });

  it("rejects JSON frames larger than 24 KiB even without a control-text field", () => {
    expect(() => parseRelayFrame(`{"type":"relay_error","code":"X","detail":"${"x".repeat(24 * 1024)}"}`)).toThrow(
      /RELAY_FRAME_TOO_LARGE/,
    );
  });
});
