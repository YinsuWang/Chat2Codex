import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveContainedPath } from "../../src/workspace/containment.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "chat2codex-contained-"));
  outside = await mkdtemp(join(tmpdir(), "chat2codex-outside-"));
  await writeFile(join(root, ".env.example"), "SAMPLE=1\n");
  await writeFile(join(root, ".env"), "SECRET=1\n");
  await writeFile(join(root, ".env.local"), "SECRET=2\n");
  await writeFile(join(root, "id_rsa"), "private\n");
  await writeFile(join(root, "secret.pem"), "private\n");
  await mkdir(join(root, ".git"), { recursive: true });
  await writeFile(
    join(root, ".git", "config"),
    "[remote \"origin\"]\n\turl = https://token@example.com/repo.git\n",
  );
  await writeFile(join(outside, "outside.txt"), "outside\n");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveContainedPath", () => {
  it.each(["../escape", "/etc/passwd", "C:\\Windows\\win.ini"])(
    "rejects escape path %s",
    async (requested) => {
      await expect(resolveContainedPath(root, requested)).rejects.toThrow();
    },
  );

  it.each([".env", ".env.local", "id_rsa", "secret.pem"])(
    "denies sensitive path %s",
    async (requested) => {
      await expect(resolveContainedPath(root, requested)).rejects.toThrow(/SENSITIVE_PATH_DENIED/);
    },
  );

  it("denies Git metadata such as .git/config", async () => {
    await expect(resolveContainedPath(root, ".git/config")).rejects.toThrow(
      /SENSITIVE_PATH_DENIED/,
    );
  });

  it("allows .env.example", async () => {
    expect((await resolveContainedPath(root, ".env.example")).relativePath).toBe(".env.example");
  });

  it("rejects a symlink that escapes the workspace", async () => {
    await symlink(join(outside, "outside.txt"), join(root, "escape-link"));
    await expect(resolveContainedPath(root, "escape-link")).rejects.toThrow(/SYMLINK_ESCAPE/);
  });
});
