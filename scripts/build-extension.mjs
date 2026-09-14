import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(SCRIPT_DIR, "..");
const OUT_DIR = resolve(ROOT, "dist-extension");

await rm(OUT_DIR, { recursive: true, force: true });
await mkdir(OUT_DIR, { recursive: true });

const result = await build({
  entryPoints: {
    "service-worker": resolve(ROOT, "extension/src/service-worker.ts"),
    "content-script": resolve(ROOT, "extension/src/content-script.ts"),
    popup: resolve(ROOT, "extension/src/popup.ts"),
  },
  outdir: OUT_DIR,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["chrome116"],
  sourcemap: false,
  minify: false,
  legalComments: "none",
  metafile: true,
  write: true,
  logLevel: "silent",
});

if (result.warnings.length > 0) {
  throw new Error(`EXTENSION_BUILD_WARNINGS: ${result.warnings.map((warning) => warning.text).join("; ")}`);
}

for (const input of Object.values(result.metafile.inputs)) {
  for (const imported of input.imports) {
    if (imported.path.startsWith("node:")) {
      throw new Error(`NODE_BUILTIN_IN_EXTENSION: ${imported.path}`);
    }
  }
}

await Promise.all([
  copyFile(resolve(ROOT, "extension/manifest.json"), resolve(OUT_DIR, "manifest.json")),
  copyFile(resolve(ROOT, "extension/popup.html"), resolve(OUT_DIR, "popup.html")),
]);
