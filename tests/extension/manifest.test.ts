import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../..");
const MANIFEST_PATH = resolve(ROOT, "extension/manifest.json");
const FORBIDDEN_PERMISSIONS = new Set([
  "cookies",
  "history",
  "downloads",
  "debugger",
  "clipboardRead",
  "clipboardWrite",
  "webRequest",
]);

async function manifest(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(MANIFEST_PATH, "utf8")) as Record<string, unknown>;
}

describe("browser extension manifest", () => {
  it("uses Manifest V3 with the planned Chrome baseline and entry points", async () => {
    const value = await manifest();

    expect(value.manifest_version).toBe(3);
    expect(value.name).toBe("Chat2Codex Relay");
    expect(value.version).toBe("0.1.0");
    expect(value.minimum_chrome_version).toBe("116");
    expect(value.background).toEqual({ service_worker: "service-worker.js", type: "module" });
    expect(value.content_scripts).toEqual([
      {
        matches: ["https://chatgpt.com/*"],
        js: ["content-script.js"],
        run_at: "document_idle",
      },
    ]);
    expect(value.action).toEqual({ default_popup: "popup.html" });
  });

  it("grants only storage/tabs and chatgpt.com host access", async () => {
    const value = await manifest();
    const permissions = value.permissions as string[];
    const hostPermissions = value.host_permissions as string[];

    expect(permissions).toEqual(["storage", "tabs"]);
    expect(permissions.some((permission) => FORBIDDEN_PERMISSIONS.has(permission))).toBe(false);
    expect(hostPermissions).toEqual(["https://chatgpt.com/*"]);
    expect(hostPermissions.some((host) => /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(host))).toBe(false);
  });
});
