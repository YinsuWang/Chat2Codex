import { StringDecoder } from "node:string_decoder";

import type { CodexEvent } from "./adapter.js";

function normalizeEvent(raw: unknown): CodexEvent {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const candidate = raw as Record<string, unknown>;
    if (typeof candidate.type === "string") return candidate;
  }
  return { type: "unknown", raw };
}

function parseLine(line: string): CodexEvent {
  try {
    return normalizeEvent(JSON.parse(line) as unknown);
  } catch {
    return { type: "unknown", raw: line };
  }
}

export class JsonlDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  feed(chunk: Buffer | string): CodexEvent[] {
    this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(chunk);
    const events: CodexEvent[] = [];
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) events.push(parseLine(line));
    }
    return events;
  }

  end(): CodexEvent[] {
    this.buffer += this.decoder.end();
    const tail = this.buffer.replace(/\r$/, "");
    this.buffer = "";
    return tail.trim() ? [parseLine(tail)] : [];
  }
}
