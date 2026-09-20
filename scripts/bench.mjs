/**
 * Benchmark runner for the route core.
 *
 * Bundles `bench/route-bench.ts` with esbuild (the core uses extensionless ESM
 * TS imports node cannot load directly) and then runs each requested case in its
 * own process, with a hard timeout so a runaway search can be killed.
 *
 * Usage:
 *   node scripts/bench.mjs simple:4 complex:4 [--timeout=60000]
 *
 * Each `scenario:rows` token is one route run. A batch is refused above 9 runs
 * on purpose: the search explodes with rows, and the caller is expected to
 * fan out instead of queueing one giant job.
 *
 * Profiler frames are reported by function name; the action handlers, which all
 * share the generic name `invoke`/`able` in the bundle, are resolved back to
 * their action via the bundle's own line numbers.
 */
import { spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(rootDir, "dist", "bench");
const outFile = path.join(outDir, "route-bench.mjs");

const argv = process.argv.slice(2);
const timeoutArg = argv.find((token) => token.startsWith("--timeout="));
const timeoutMs = timeoutArg ? Number(timeoutArg.split("=")[1]) : 60_000;
const specs = argv.filter((token) => !token.startsWith("--"));

if (specs.length === 0) {
  console.error("usage: node scripts/bench.mjs <scenario:rows> [...] [--timeout=ms]");
  process.exit(2);
}
if (specs.length > 9) {
  console.error(`refusing ${specs.length} runs in one batch; limit is 9 (keep batches small)`);
  process.exit(2);
}

const parsed = specs.map((spec) => {
  const [scenario, rowsText] = spec.split(":");
  const rows = Number.parseInt(rowsText ?? "", 10);
  if (scenario === undefined || !Number.isFinite(rows) || rows < 1 || rows > 8) {
    console.error(`bad spec "${spec}", expected <scenario>:<rows 1..8>`);
    process.exit(2);
  }
  return { scenario, rows, spec };
});

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

await esbuild.build({
  entryPoints: [path.join(rootDir, "bench", "route-bench.ts")],
  outfile: outFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "es2022",
  logLevel: "warning",
});

// ---------------------------------------------------------------------------
// Resolve generic profiler frames (`invoke @ file:NN`) back to action names.
// ---------------------------------------------------------------------------
const bundleLines = (await readFile(outFile, "utf8")).split("\n");
const invokeLines = new Map();
const ableLines = new Map();
const gfdCostLines = new Map();

let currentAction = null;
for (let i = 0; i < bundleLines.length; i++) {
  const line = bundleLines[i];
  const nameMatch = /^\s*name: "([^"]+)",\s*$/.exec(line);
  if (nameMatch) currentAction = nameMatch[1];
  if (!currentAction) continue;
  if (/^\s*invoke: \(state\) =>/.test(line)) invokeLines.set(i + 1, currentAction);
  if (/^\s*able: \(state\) =>/.test(line)) ableLines.set(i + 1, currentAction);
  if (/^\s*gfdCost: \(state\) =>/.test(line)) gfdCostLines.set(i + 1, currentAction);
}

let mapCallbackLine = null;
for (let i = 0; i < bundleLines.length; i++) {
  if (bundleLines[i].includes("pendingResolves.map")) mapCallbackLine = i + 1;
}

function cleanKey(key) {
  const framed = /^(invoke|able|gfdCost) @ route-bench\.mjs:(\d+)$/.exec(key);
  if (framed) {
    const kind = framed[1];
    const line = Number(framed[2]);
    const map = kind === "invoke" ? invokeLines : kind === "able" ? ableLines : gfdCostLines;
    const action = map.get(line);
    if (action) return `${kind}:${action}`;
    return key;
  }
  const anonymous = /^\(anonymous\) @ route-bench\.mjs:(\d+)$/.exec(key);
  if (anonymous) {
    if (Number(anonymous[1]) === mapCallbackLine) return "pendingResolves.map callback";
    return "(anonymous)";
  }
  const generic = /^([A-Za-z_$][\w$]*) @ route-bench\.mjs:\d+$/.exec(key);
  if (generic) return generic[1] === "_RouteState" ? "RouteState ctor" : generic[1];
  return key;
}

function cleanTable(table) {
  const merged = new Map();
  for (const [key, value] of Object.entries(table)) {
    const clean = cleanKey(key);
    merged.set(clean, (merged.get(clean) ?? 0) + value);
  }
  return merged;
}

const isGfdScanKey = (key) =>
  key === "tryCastGFDTo" || key === "gfdGetsSpell" || key.startsWith("invoke:g!");

function gfdScanMs(selfTable) {
  let sum = 0;
  for (const [key, value] of selfTable) if (isGfdScanKey(key)) sum += value;
  return sum;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function runOne({ scenario, rows, spec }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [outFile, scenario, String(rows)], { cwd: rootDir });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ spec, timedOut: true });
        return;
      }
      const line = stdout
        .split("\n")
        .filter((candidate) => candidate.startsWith("BENCH_JSON "))
        .pop();
      if (!line) {
        resolve({ spec, error: `no result (exit ${code})\n${stdout}\n${stderr}`.trim() });
        return;
      }
      const data = JSON.parse(line.slice("BENCH_JSON ".length));
      data.selfClean = cleanTable(data.self);
      data.totalClean = cleanTable(data.total);
      data.gfdMs = gfdScanMs(data.selfClean);
      resolve({ spec, data });
    });
  });
}

const results = [];
for (const caseSpec of parsed) {
  process.stderr.write(`running ${caseSpec.spec} ...\n`);
  const outcome = await runOne(caseSpec);
  results.push(outcome);
  const label = outcome.timedOut
    ? `TIMEOUT after ${timeoutMs}ms`
    : outcome.error
      ? "failed"
      : `${outcome.data.elapsedMs}ms, ${outcome.data.steps} steps`;
  process.stderr.write(`  ${caseSpec.spec}: ${label}\n`);
}

// ---------------------------------------------------------------------------
// Report helpers
// ---------------------------------------------------------------------------
const fmt = (value, digits = 2) =>
  value === undefined || value === null || Number.isNaN(value) ? "-" : Number(value).toFixed(digits);
const pad = (text, width, align = "left") => {
  const string = String(text);
  if (string.length >= width) return string;
  const filler = " ".repeat(width - string.length);
  return align === "right" ? filler + string : string + filler;
};
const pct = (part, whole) => (whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "-");

console.log("\n=== runs ===");
console.log(
  [
    pad("case", 12),
    pad("score", 6, "right"),
    pad("route len", 10, "right"),
    pad("steps", 12, "right"),
    pad("elapsed ms", 11, "right"),
    pad("ms/step", 10, "right"),
    pad("gc ms", 8, "right"),
    pad("gfd scan ms", 12, "right"),
    pad("gfd share", 10, "right"),
  ].join(" "),
);
for (const outcome of results) {
  if (outcome.timedOut) {
    console.log(`${pad(outcome.spec, 12)} TIMEOUT`);
    continue;
  }
  if (outcome.error) {
    console.log(`${pad(outcome.spec, 12)} ERROR: ${outcome.error.split("\n")[0]}`);
    continue;
  }
  const d = outcome.data;
  console.log(
    [
      pad(outcome.spec, 12),
      pad(d.score, 6, "right"),
      pad(d.route.length, 10, "right"),
      pad(d.steps.toLocaleString("en-US"), 12, "right"),
      pad(fmt(d.elapsedMs), 11, "right"),
      pad(d.msPerStep.toFixed(6), 10, "right"),
      pad(fmt(d.gcMs), 8, "right"),
      pad(fmt(d.gfdMs), 12, "right"),
      pad(pct(d.gfdMs, d.elapsedMs), 10, "right"),
    ].join(" "),
  );
}

const byScenario = new Map();
for (const outcome of results) {
  if (!outcome.data) continue;
  const list = byScenario.get(outcome.data.scenario) ?? [];
  list.push(outcome.data);
  byScenario.set(outcome.data.scenario, list);
}

const TOP = 12;
for (const [scenario, runs] of byScenario) {
  runs.sort((a, b) => a.rows - b.rows);

  const union = new Set();
  for (const run of runs) {
    const ordered = [...run.selfClean.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP);
    for (const [key] of ordered) union.add(key);
  }

  console.log(`\n=== ${scenario}: self time (ms) by rows ===`);
  console.log([pad("function", 30), ...runs.map((run) => pad(`r${run.rows}`, 9, "right"))].join(" "));
  console.log(
    [
      pad("(elapsed)", 30),
      ...runs.map((run) => pad(fmt(run.elapsedMs), 9, "right")),
    ].join(" "),
  );
  for (const key of union) {
    console.log(
      [pad(key, 30), ...runs.map((run) => pad(fmt(run.selfClean.get(key) ?? 0), 9, "right"))].join(
        " ",
      ),
    );
  }

  const last = runs[runs.length - 1];
  console.log(`\n--- ${scenario}: top self at r${last.rows} (${fmt(last.elapsedMs)} ms) ---`);
  const ranked = [...last.selfClean.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  for (const [key, value] of ranked) {
    console.log(
      `  ${pad(key, 28)} ${pad(fmt(value), 9, "right")} ms  ${pad(pct(value, last.elapsedMs), 7, "right")}`,
    );
  }
}

console.log("\n=== routes & counters ===");
for (const outcome of results) {
  if (!outcome.data) continue;
  const d = outcome.data;
  const counters = d.counters;
  const gfdInvocations = Object.entries(counters)
    .filter(([key]) => key.startsWith("invoke:g!"))
    .reduce((sum, [, value]) => sum + value, 0);
  console.log(`\n-- ${outcome.spec} --`);
  console.log(`  score ${d.score}, steps ${d.steps.toLocaleString("en-US")}, route: ${d.route.join(", ")}`);
  console.log(
    `  duplicate ${(counters.duplicate ?? 0).toLocaleString("en-US")}  act ${(counters.act ?? 0).toLocaleString("en-US")}  ` +
      `getCost ${(counters.getCost ?? 0).toLocaleString("en-US")}  currentValue ${(counters.currentValue ?? 0).toLocaleString("en-US")}  ` +
      `indexedParentLatest ${(counters.indexedParentLatest ?? 0).toLocaleString("en-US")}`,
  );
  console.log(
    `  g! invocations ${gfdInvocations.toLocaleString("en-US")}  table rows walked (upper bound) ${(counters.gfdScanRowsUpper ?? 0).toLocaleString("en-US")}  ` +
      `scan rows / step ${d.steps > 0 ? ((counters.gfdScanRowsUpper ?? 0) / d.steps).toFixed(1) : "-"}`,
  );
}

// ---------------------------------------------------------------------------
// Route-tree composition
// ---------------------------------------------------------------------------
const CATEGORY_ORDER = ["stacking", "long", "gfdMixed", "regular"];

const integer = (value) => Number(value).toLocaleString("en-US");

/**
 * Time model: the profiled GFD-scan time divided by the total table rows walked
 * gives ns/row, which is then re-applied per category. Everything that is not
 * GFD scanning (iterate's own loop, duplicate/act, GC) is split by *attempt*
 * share, since those costs are paid once per action attempt.
 */
console.log("\n=== route-tree composition ===");
for (const outcome of results) {
  if (!outcome.data || !outcome.data.composition) continue;
  const d = outcome.data;
  const c = d.composition;
  const nsPerRow = c.totalScanRows > 0 ? (d.gfdMs * 1e6) / c.totalScanRows : 0;
  const nonScanMs = Math.max(d.elapsedMs - d.gfdMs, 0);

  console.log(
    `\n-- ${outcome.spec}: score ${d.score}, steps ${integer(d.steps)}, elapsed ${fmt(d.elapsedMs)} ms, ` +
      `nodes ${integer(c.totalNodes)} (steps+1 = ${integer(d.steps + 1)}), max depth ${c.maxDepth} --`,
  );
  console.log(
    `   thresholds: stacking P>=${c.thresholds.STACKING_PENDING}, long L>=${c.thresholds.LONG_DEPTH}, ` +
      `gfdMixed G/L>=${c.thresholds.GFD_MIXED_RATIO.toFixed(2)}; calibration ${nsPerRow.toFixed(2)} ns per table row`,
  );
  console.log(
    [
      "   " + pad("category", 10),
      pad("nodes", 10, "right"),
      pad("node%", 7, "right"),
      pad("expand", 10, "right"),
      pad("exp%", 7, "right"),
      pad("attempts", 11, "right"),
      pad("att%", 7, "right"),
      pad("scan rows", 13, "right"),
      pad("scan%", 7, "right"),
      pad("scan ms", 9, "right"),
      pad("other ms", 9, "right"),
      pad("total ms", 9, "right"),
      pad("time%", 7, "right"),
    ].join(" "),
  );

  let totalMs = 0;
  let totalExpanded = 0;
  const rows = [];
  for (const key of CATEGORY_ORDER) {
    const stat = c.categories[key];
    const scanMs = (stat.scanRows * nsPerRow) / 1e6;
    const otherMs = c.totalAttempts > 0 ? nonScanMs * (stat.attempts / c.totalAttempts) : 0;
    const categoryMs = scanMs + otherMs;
    totalMs += categoryMs;
    totalExpanded += stat.expanded;
    rows.push({ key, stat, scanMs, otherMs, categoryMs });
  }

  for (const { key, stat, scanMs, otherMs, categoryMs } of rows) {
    console.log(
      [
        "   " + pad(key, 10),
        pad(integer(stat.nodes), 10, "right"),
        pad(c.totalNodes > 0 ? `${((stat.nodes / c.totalNodes) * 100).toFixed(1)}%` : "-", 7, "right"),
        pad(integer(stat.expanded), 10, "right"),
        pad(totalExpanded > 0 ? `${((stat.expanded / totalExpanded) * 100).toFixed(1)}%` : "-", 7, "right"),
        pad(integer(stat.attempts), 11, "right"),
        pad(c.totalAttempts > 0 ? `${((stat.attempts / c.totalAttempts) * 100).toFixed(1)}%` : "-", 7, "right"),
        pad(integer(stat.scanRows), 13, "right"),
        pad(c.totalScanRows > 0 ? `${((stat.scanRows / c.totalScanRows) * 100).toFixed(1)}%` : "-", 7, "right"),
        pad(fmt(scanMs), 9, "right"),
        pad(fmt(otherMs), 9, "right"),
        pad(fmt(categoryMs), 9, "right"),
        pad(totalMs > 0 ? `${((categoryMs / totalMs) * 100).toFixed(1)}%` : "-", 7, "right"),
      ].join(" "),
    );
  }
  console.log(
    [
      "   " + pad("(all)", 10),
      pad(integer(c.totalNodes), 10, "right"),
      pad("100%", 7, "right"),
      pad(integer(totalExpanded), 10, "right"),
      pad("100%", 7, "right"),
      pad(integer(c.totalAttempts), 11, "right"),
      pad("100%", 7, "right"),
      pad(integer(c.totalScanRows), 13, "right"),
      pad("100%", 7, "right"),
      pad(fmt(d.gfdMs), 9, "right"),
      pad(fmt(nonScanMs), 9, "right"),
      pad(fmt(totalMs), 9, "right"),
      pad("100%", 7, "right"),
    ].join(" "),
  );
  console.log(
    `   dead-end leaves: ${integer(c.totalNodes - totalExpanded)} of ${integer(c.totalNodes)} nodes ` +
      `(${c.totalNodes > 0 ? (((c.totalNodes - totalExpanded) / c.totalNodes) * 100).toFixed(1) : "-"}%), no legal action -> zero attribution`,
  );

  const showHistogram = (label, buckets) => {
    const parts = [];
    for (let i = 0; i < buckets.length; i++) {
      if ((buckets[i] ?? 0) === 0) continue;
      parts.push(`${i}:${buckets[i]}`);
      if (parts.length >= 14) break;
    }
    console.log(`   ${pad(label, 16)} ${parts.join("  ")}`);
  };
  showHistogram("depth L", c.histogram.depth);
  showHistogram("g! casts G", c.histogram.gfd);
  showHistogram("pending P", c.histogram.pending);
}
