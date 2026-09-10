import { describe, expect, it } from "vitest";

import { JsonlDecoder } from "../../src/codex/jsonl.js";

describe("JsonlDecoder", () => {
  it("preserves UTF-8 and events across arbitrary chunk boundaries", () => {
    const decoder = new JsonlDecoder();
    const check = Buffer.from("✓", "utf8");
    const first = Buffer.concat([Buffer.from('{"type":"one","value":"'), check.subarray(0, 1)]);
    const second = Buffer.concat([check.subarray(1), Buffer.from('"}\n{"type":"two","ok":true}')]);
    const events = [...decoder.feed(first), ...decoder.feed(second), ...decoder.end()];
    expect(events).toEqual([
      { type: "one", value: "✓" },
      { type: "two", ok: true },
    ]);
  });

  it("preserves unknown shapes instead of crashing", () => {
    const decoder = new JsonlDecoder();
    expect([...decoder.feed('{"foo":1}\n'), ...decoder.end()]).toEqual([
      { type: "unknown", raw: { foo: 1 } },
    ]);
  });
});
