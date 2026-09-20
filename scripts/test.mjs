import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

/**
 * The core is TypeScript with extensionless ESM imports, which node cannot
 * load directly, so the tests are bundled with esbuild first and then handed
 * to node's built-in test runner. Nothing here is shipped to the browser.
 */
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "test"); // dist/ is gitignored build output
const entries = ["route.test.ts", "microrouter.test.ts"];

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: entries.map((name) => path.join(rootDir, "src", "app", "tests", name)),
  outdir: outDir,
  // esbuild names the chunks after the entry, so ask for the .mjs the runner loads.
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  sourcemap: "inline",
  logLevel: "warning",
});

const outFiles = entries.map((name) => path.join(outDir, name.replace(/\.ts$/, ".mjs")));

const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=spec", ...process.argv.slice(2), ...outFiles],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
