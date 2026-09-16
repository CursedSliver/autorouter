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
const outFile = path.join(outDir, "route.test.mjs");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "src", "app", "tests", "route.test.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  sourcemap: "inline",
  logLevel: "warning",
});

const child = spawn(
  process.execPath,
  ["--test", "--test-reporter=spec", ...process.argv.slice(2), outFile],
  { stdio: "inherit" },
);

child.on("exit", (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
