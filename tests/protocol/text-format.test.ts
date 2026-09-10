import { describe, expect, it } from "vitest";

import {
  CONTROL_TEXT_MARKER,
  MAX_CONTROL_TEXT_BYTES,
  formatControlText,
  parseControlText,
} from "../../src/protocol/text-format.js";
import type { DoneMessage } from "../../src/protocol/types.js";

const doneMessage: DoneMessage = {
  kind: "DONE",
  workspace_id: "ws_abc123",
  task_id: "task_001",
  iteration: 2,
  summary: "Accepted",
};

describe("control text framing", () => {
  it("parses a framed control message", () => {
    const text = `${CONTROL_TEXT_MARKER}\n${JSON.stringify(doneMessage)}`;

    expect(parseControlText(text)).toEqual(doneMessage);
  });

  it("formats exactly one marker line followed by JSON", () => {
    expect(formatControlText(doneMessage)).toBe(
      `${CONTROL_TEXT_MARKER}\n${JSON.stringify(doneMessage)}`,
    );
  });

  it("rejects text without the Chat2Codex marker", () => {
    expect(() => parseControlText(JSON.stringify(doneMessage))).toThrow(
      /must start/i,
    );
  });

  it("rejects control text larger than 16 KiB", () => {
    const oversized = `${CONTROL_TEXT_MARKER}\n${"x".repeat(MAX_CONTROL_TEXT_BYTES)}`;

    expect(() => parseControlText(oversized)).toThrow(/exceeds/i);
  });
});
