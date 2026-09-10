import { access, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const DEFAULT_SENSITIVE_PATTERNS = [
  ".env",
  ".env.*",
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "*.pem",
  "*.key",
  "*.p12",
  "*.pfx",
  ".git/credentials",
  ".ssh",
  ".ssh/**",
  ".aws/credentials",
  ".config/gcloud/application_default_credentials.json",
] as const;

function comparisonKey(path: string): string {
  return process.platform === "win32" || process.platform === "darwin"
    ? path.toLowerCase()
    : path;
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function normalizeRequestedPath(requested: string): string {
  if (requested.includes("\0")) throw new Error("PATH_NUL_BYTE");
  if (requested === "") return ".";
  if (isAbsolute(requested) || /^[A-Za-z]:[\\/]/.test(requested) || /^\\\\/.test(requested) || /^\/\//.test(requested)) {
    throw new Error("ABSOLUTE_PATH_NOT_ALLOWED");
  }
  const portable = requested.replace(/[\\/]+/g, sep);
  if (portable.split(sep).some((segment) => segment === "..")) {
    throw new Error("PATH_TRAVERSAL_NOT_ALLOWED");
  }
  return portable;
}

function globMatch(pattern: string, path: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^(?:${escaped})$`, "i").test(path);
}

export function isHardDeniedRelativePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (basename === ".env.example") return false;
  for (const pattern of DEFAULT_SENSITIVE_PATTERNS) {
    const normalizedPattern = pattern.replace(/\\/g, "/");
    if (normalizedPattern.includes("/")) {
      if (globMatch(normalizedPattern, normalized)) return true;
    } else if (globMatch(normalizedPattern, basename)) {
      return true;
    }
  }
  return false;
}

async function deepestExistingAncestor(candidate: string): Promise<{ ancestor: string; tail: string[] }> {
  let current = candidate;
  const tail: string[] = [];
  for (;;) {
    try {
      await access(current);
      return { ancestor: current, tail };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = dirname(current);
      if (parent === current) throw new Error("NO_EXISTING_PATH_ANCESTOR");
      tail.unshift(current.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      current = parent;
    }
  }
}

export interface ContainedPath {
  absolutePath: string;
  relativePath: string;
}

export async function resolveContainedPath(root: string, requested: string): Promise<ContainedPath> {
  const rootReal = await realpath(root);
  const normalizedRequest = normalizeRequestedPath(requested);
  const lexicalCandidate = resolve(rootReal, normalizedRequest);
  if (!isContained(comparisonKey(rootReal), comparisonKey(lexicalCandidate))) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const { ancestor, tail } = await deepestExistingAncestor(lexicalCandidate);
  const ancestorReal = await realpath(ancestor);
  if (!isContained(comparisonKey(rootReal), comparisonKey(ancestorReal))) {
    throw new Error("SYMLINK_ESCAPE");
  }
  const canonicalCandidate = tail.length > 0 ? join(ancestorReal, ...tail) : ancestorReal;
  if (!isContained(comparisonKey(rootReal), comparisonKey(canonicalCandidate))) {
    throw new Error("PATH_OUTSIDE_WORKSPACE");
  }
  const relativePath = relative(rootReal, canonicalCandidate).replace(/\\/g, "/") || ".";
  if (relativePath !== "." && isHardDeniedRelativePath(relativePath)) {
    throw new Error(`SENSITIVE_PATH_DENIED: ${relativePath}`);
  }
  return { absolutePath: canonicalCandidate, relativePath };
}
