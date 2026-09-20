/**
 * Single-run benchmark entry point for the route core.
 *
 * It runs exactly one `route()` call under the V8 CPU profiler and prints a
 * JSON summary on stdout (prefixed with `BENCH_JSON `). The runner
 * (`scripts/bench.mjs`) spawns one process per run so a slow/hanging search can
 * be killed without taking the rest down.
 *
 * Instrumentation policy: prototype methods and `Action` handlers are wrapped
 * with *counting* shims only (no per-call clocks), because the profiler already
 * attributes time. The shims answer "how often", the profile answers "how long".
 * Shim frames are tiny and the profiler whitelist drops them from the report.
 */
import { Session } from "node:inspector";

import route, { Actions, RouteState } from "../src/app/route/route";
import type { Action, Spell } from "../src/app/route/route";
import { createSpell } from "../src/lib/spell";

interface ScenarioInput {
  spells: Spell[];
  metamax: number;
  currentMagic: number;
  startingRefills: 0 | 1 | 2;
  goal: number;
}

/**
 * `simple` is the "few sparse effects, easy to reach" case: a lone effect per
 * row, no backfires, abundant magic.
 *
 * `complex` is the "many offset gfd resolves, transmutation required, tight
 * magic" case: every row hides its effect behind a partial GFD roll and the
 * pool starts at 40 magic, so consumes have to be transmuted/refunded.
 */
const SCENARIOS: Record<string, (rows: number) => ScenarioInput> = {
  simple: (rows) => ({
    spells: Array.from({ length: rows }, (_, i) =>
      createSpell(i % 2 === 0 ? { bs: true, gfdRs: 0.5 } : { cf: true, gfdRs: 0.5 }),
    ),
    metamax: 200,
    currentMagic: 200,
    startingRefills: 0,
    goal: 1,
  }),
  complex: (rows) => ({
    spells: Array.from({ length: rows }, () => createSpell({ bs: true, gfdRs: 0.3 })),
    metamax: 200,
    currentMagic: 40,
    startingRefills: 0,
    goal: 1,
  }),
};

// ---------------------------------------------------------------------------
// Counting shims
// ---------------------------------------------------------------------------
const counters: Record<string, number> = {};
const bump = (label: string, amount = 1): void => {
  counters[label] = (counters[label] ?? 0) + amount;
};

// ---------------------------------------------------------------------------
// Route-tree composition
// ---------------------------------------------------------------------------
/**
 * Every state the search materialises is classified by the route prefix that
 * produced it: path length `L` (actions), g!-cast count `G`, and pending-resolve
 * stack `P`. Categories are mutually exclusive, with this precedence, so the
 * requested route types stay separable:
 *
 *   stacking  P >= 2                  high-g! route with queued resolves
 *   long      L >= LONG_DEPTH         long action chains
 *   gfdMixed  G/L >= GFD_MIXED_RATIO  g!-leaning but short and not stacking
 *   regular   otherwise               mainly normal spells
 */
const STACKING_PENDING = 2;
const LONG_DEPTH = 6;
const GFD_MIXED_RATIO = 1 / 3;

const CATEGORIES = ["stacking", "long", "gfdMixed", "regular"] as const;
type Category = (typeof CATEGORIES)[number];

interface CategoryStats {
  /** Every state of this type the search visited (including dead-end leaves). */
  nodes: number;
  /** States of this type that had at least one legal action (where work happens). */
  expanded: number;
  /** Action attempts made while expanding a state of this type. */
  attempts: number;
  /** GFD table rows scanned while expanding a state of this type. */
  scanRows: number;
}

const categoryStats: Record<Category, CategoryStats> = {
  stacking: { nodes: 0, expanded: 0, attempts: 0, scanRows: 0 },
  long: { nodes: 0, expanded: 0, attempts: 0, scanRows: 0 },
  gfdMixed: { nodes: 0, expanded: 0, attempts: 0, scanRows: 0 },
  regular: { nodes: 0, expanded: 0, attempts: 0, scanRows: 0 },
};

/** Tree shape as counts per bucket. */
const histogram = {
  depth: [] as number[],
  gfd: [] as number[],
  pending: [] as number[],
};
let totalNodes = 0;
let maxDepth = 0;

/** `RouteState` extended with the harness's own path metadata. */
interface TaggedState extends RouteState {
  __depth?: number;
  __gfd?: number;
  __expanded?: boolean;
}

const bumpBucket = (buckets: number[], index: number): void => {
  buckets[index] = (buckets[index] ?? 0) + 1;
};

function classifyNode(node: TaggedState): Category {
  const depth = node.__depth ?? 0;
  const gfd = node.__gfd ?? 0;

  if (node.pendingResolves.length >= STACKING_PENDING) return "stacking";
  if (depth >= LONG_DEPTH) return "long";
  if (depth > 0 && gfd / depth >= GFD_MIXED_RATIO) return "gfdMixed";
  return "regular";
}

function recordNode(node: TaggedState): void {
  const depth = node.__depth ?? 0;

  categoryStats[classifyNode(node)].nodes++;
  totalNodes++;
  bumpBucket(histogram.depth, depth);
  bumpBucket(histogram.gfd, node.__gfd ?? 0);
  bumpBucket(histogram.pending, node.pendingResolves.length);
  if (depth > maxDepth) maxDepth = depth;
}

/**
 * V8 only infers a function's name for anonymous function *definitions* placed
 * in an object literal (a computed key counts), not for references or
 * `defineProperty` afterwards. Defining each shim inline under a computed key
 * therefore gives the profiler a distinct, filterable `count:<label>` frame
 * instead of collapsing every shim into one anonymous one.
 */

/**
 * `ROUTE_BENCH_PLAIN=1` installs the counting shims but none of the composition
 * metadata, to measure how much the instrumentation itself costs.
 */
const PLAIN = process.env.ROUTE_BENCH_PLAIN === "1";

function installShims(): void {
  const proto = RouteState.prototype as unknown as Record<string, unknown>;
  // Plain counting shims for the methods that carry no composition metadata.
  for (const key of [
    "peek",
    "increment",
    "addResolve",
    "backfires",
    "backfiresGFD",
    "getCost",
    "castArbitrary",
    "castSpell",
    "resolve",
    "refill",
    "addBuff",
    "currentValue",
    "indexedParent",
    "indexedParentLatest",
  ]) {
    const original = proto[key];
    if (typeof original !== "function") continue;
    proto[key] = {
      [`count:${key}`]: function (this: unknown, ...args: unknown[]): unknown {
        bump(key);
        return (original as (...a: unknown[]) => unknown).apply(this, args);
      },
    }[`count:${key}`];
  }

  /**
   * `ended()` is the first thing `iterate` calls on every node it visits, so it
   * is the exact "this state is part of the explored tree" hook - leaves that
   * have no legal action are counted too, unlike a `duplicate`-based hook.
   */
  const originalEnded = proto.ended as (this: TaggedState) => boolean;
  proto.ended = {
    "count:ended": function (this: TaggedState): boolean {
      bump("ended");
      if (!PLAIN) recordNode(this);
      return originalEnded.call(this);
    },
  }["count:ended"];

  /**
   * `duplicate` carries the harness path metadata onto the child; the metadata
   * advances only when an action lands (`act`).
   */
  const originalDuplicate = proto.duplicate as (this: TaggedState) => TaggedState;
  proto.duplicate = {
    "count:duplicate": function (this: TaggedState): TaggedState {
      bump("duplicate");
      const child = originalDuplicate.call(this);
      if (!PLAIN) {
        child.__depth = this.__depth ?? 0;
        child.__gfd = this.__gfd ?? 0;
        child.__expanded = false;
        // `duplicate` is only reached for nodes that have a legal action, so the
        // first call marks a node as one the search actually works on.
        if (!this.__expanded) {
          this.__expanded = true;
          categoryStats[classifyNode(this)].expanded++;
        }
      }
      return child;
    },
  }["count:duplicate"];

  const originalAct = proto.act as (this: TaggedState, action: Action) => boolean;
  proto.act = {
    "count:act": function (this: TaggedState, action: Action): boolean {
      bump("act");
      const applied = originalAct.call(this, action);
      if (applied && !PLAIN) {
        this.__depth = (this.__depth ?? 0) + 1;
        if (action.name.startsWith("g!")) this.__gfd = (this.__gfd ?? 0) + 1;
      }
      return applied;
    },
  }["count:act"];

  for (const action of Actions) {
    const isGfd = action.name.startsWith("g!");
    const originalInvoke = action.invoke;
    action.invoke = {
      [`count:invoke:${action.name}`]: function (state: RouteState): unknown {
        bump(`invoke:${action.name}`);
        if (isGfd) {
          // Upper bound on the table rows `tryCastGFDTo` walks for this cast:
          // it scans `currentMagic..metamax` and only stops early on a match.
          const rows = state.metamax - state.currentMagic + 1;
          bump("gfdScanRowsUpper", rows);
          if (!PLAIN) {
            // The action is applied to a fresh child, and that child's parent is
            // the state whose expansion is paying for this attempt, so the cost
            // is booked against the parent's route prefix.
            const node = ((state as TaggedState).parent ?? state) as TaggedState;
            const category = classifyNode(node);
            categoryStats[category].scanRows += rows;
            categoryStats[category].attempts++;
          }
        } else if (!PLAIN) {
          const node = ((state as TaggedState).parent ?? state) as TaggedState;
          categoryStats[classifyNode(node)].attempts++;
        }
        return originalInvoke(state);
      },
    }[`count:invoke:${action.name}`];

    const originalAble = action.able;
    action.able = {
      [`count:able:${action.name}`]: function (state: RouteState): boolean {
        bump(`able:${action.name}`);
        return originalAble(state);
      },
    }[`count:able:${action.name}`];

    if (action.gfdCost) {
      const originalCost = action.gfdCost;
      action.gfdCost = {
        [`count:gfdCost:${action.name}`]: function (state: RouteState): number {
          bump(`gfdCost:${action.name}`);
          return originalCost(state);
        },
      }[`count:gfdCost:${action.name}`];
    }
  }
}

// ---------------------------------------------------------------------------
// Profiler plumbing
// ---------------------------------------------------------------------------
interface RawProfile {
  nodes: Array<{
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
    children?: number[];
  }>;
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

const BUNDLE = "route-bench.mjs";

/**
 * Only the route core's own frames are reported. Everything else in the bundle
 * is harness scaffolding (shims, profiler plumbing), and node internals are
 * noise; the empty-url buckets carry GC / program time and are kept.
 */
const ROUTE_FUNCTIONS = new Set([
  "invoke",
  "able",
  "gfdCost",
  "duplicate",
  "act",
  "peek",
  "increment",
  "ended",
  "addResolve",
  "backfires",
  "backfiresGFD",
  "getCost",
  "castArbitrary",
  "castSpell",
  "resolve",
  "refill",
  "addBuff",
  "currentValue",
  "indexedParent",
  "indexedParentLatest",
  "tryCastGFDTo",
  "gfdGetsSpell",
  "iterate",
  "route",
  "estimateTotalSteps",
  "isNoop",
  "progressEstimate",
  "reportProgress",
  "_RouteState",
]);

function keepFrame(node: RawProfile["nodes"][number]): boolean {
  const { functionName, url } = node.callFrame;
  const name = functionName.length > 0 ? functionName : "(anonymous)";

  if (url.length === 0) return name === "(garbage collector)" || name === "(program)" || name === "(idle)";
  if (!url.includes(BUNDLE)) return false;
  // Counting shims are harness overhead, not route code.
  if (name.startsWith("count:")) return false;
  // The only anonymous route frame is `duplicate`'s pendingResolves.map callback.
  if (name === "(anonymous)") return true;
  return ROUTE_FUNCTIONS.has(name);
}

function profileKey(node: RawProfile["nodes"][number]): string {
  const { functionName, url, lineNumber } = node.callFrame;
  const name = functionName.length > 0 ? functionName : "(anonymous)";
  if (url.length === 0) return name;
  return `${name} @ ${url.split("/").slice(-1)[0]}:${lineNumber + 1}`;
}

/** Self time (node's own samples) and inclusive time (node + all descendants). */
function aggregate(profile: RawProfile): { self: Map<string, number>; total: Map<string, number> } {
  const nodeById = new Map<number, RawProfile["nodes"][number]>();
  for (const node of profile.nodes) nodeById.set(node.id, node);

  const parentOf = new Map<number, number>();
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parentOf.set(child, node.id);
  }

  const self = new Map<string, number>();
  const total = new Map<string, number>();

  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i];
    if (id === undefined) continue;
    // `timeDeltas[i]` is the interval that *precedes* sample i.
    const delta = profile.timeDeltas[i] ?? 0;

    const leaf = nodeById.get(id);
    if (leaf && keepFrame(leaf)) {
      const key = profileKey(leaf);
      self.set(key, (self.get(key) ?? 0) + delta);
    }

    const seen = new Set<number>();
    let cursor: number | undefined = id;
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      const node = nodeById.get(cursor);
      if (node && keepFrame(node)) {
        const key = profileKey(node);
        total.set(key, (total.get(key) ?? 0) + delta);
      }
      cursor = parentOf.get(cursor);
    }
  }

  return { self, total };
}

const post = (session: Session, method: string, params?: object): Promise<unknown> =>
  new Promise((resolve, reject) => {
    session.post(method, (params ?? {}) as never, (error, result) =>
      error ? reject(error) : resolve(result),
    );
  });

const round = (value: number, digits = 3): number => Number(value.toFixed(digits));

const toMilliseconds = (table: Map<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [key, micros] of table) out[key] = round(micros / 1000);
  return out;
};

async function main(): Promise<void> {
  const [, , scenarioName, rowsText] = process.argv;
  const rows = Number.parseInt(rowsText ?? "", 10);
  const build = scenarioName ? SCENARIOS[scenarioName] : undefined;

  if (!build || !Number.isFinite(rows) || rows < 1 || rows > 8) {
    console.error(
      `usage: route-bench <${Object.keys(SCENARIOS).join("|")}> <rows 1..8>\nreceived: ${process.argv.slice(2).join(" ") || "(nothing)"}`,
    );
    process.exit(2);
  }

  installShims();

  const input = build(rows);
  let steps = 0;
  let lastProgress: { steps: number; progress: number; score: number } | null = null;

  const session = new Session();
  session.connect();
  await post(session, "Profiler.enable");
  await post(session, "Profiler.setSamplingInterval", { interval: 100 });

  const heapBefore = process.memoryUsage().heapUsed;
  await post(session, "Profiler.start");

  const startedAt = performance.now();
  const result = route({
    spells: input.spells,
    goal: input.goal,
    metamax: input.metamax,
    currentMagic: input.currentMagic,
    startingRefills: input.startingRefills,
    onProgress: (progress) => {
      steps = progress.steps;
      lastProgress = progress;
    },
  });
  const elapsedMs = performance.now() - startedAt;

  const stopped = (await post(session, "Profiler.stop")) as { profile: RawProfile };
  session.disconnect();
  const heapAfter = process.memoryUsage().heapUsed;

  const { self, total } = aggregate(stopped.profile);
  const selfObject = toMilliseconds(self);
  const totalObject = toMilliseconds(total);

  const gcKey = [...self.keys()].find((key) => key.startsWith("(garbage collector)"));
  const gcMs = gcKey ? round((self.get(gcKey) ?? 0) / 1000) : 0;
  const profiledSelfMs = round([...self.values()].reduce((sum, micros) => sum + micros, 0) / 1000, 2);

  const composition = {
    thresholds: { STACKING_PENDING, LONG_DEPTH, GFD_MIXED_RATIO },
    categories: categoryStats,
    totalNodes,
    totalAttempts: CATEGORIES.reduce((sum, key) => sum + categoryStats[key].attempts, 0),
    totalScanRows: CATEGORIES.reduce((sum, key) => sum + categoryStats[key].scanRows, 0),
    maxDepth,
    // Buckets are dense up to the largest observed index.
    histogram: {
      depth: histogram.depth.map((count) => count ?? 0),
      gfd: histogram.gfd.map((count) => count ?? 0),
      pending: histogram.pending.map((count) => count ?? 0),
    },
  };

  const summary = {
    scenario: scenarioName,
    rows,
    score: result.currentValue(),
    consumed: result.spellIndex,
    /** Action names of the reported route, oldest first. */
    route: result.history().map((step) => step.action),
    steps,
    finalProgress: lastProgress,
    elapsedMs: round(elapsedMs, 2),
    msPerStep: steps > 0 ? round(elapsedMs / steps, 6) : 0,
    samples: stopped.profile.samples.length,
    profiledSelfMs,
    heapBeforeMb: round(heapBefore / 1048576, 2),
    heapAfterMb: round(heapAfter / 1048576, 2),
    heapDeltaMb: round((heapAfter - heapBefore) / 1048576, 2),
    gcMs,
    counters,
    composition,
    self: selfObject,
    total: totalObject,
  };

  process.stdout.write(`BENCH_JSON ${JSON.stringify(summary)}\n`);
}

main().catch((error) => {
  console.error("bench failed:", error);
  process.exit(1);
});
