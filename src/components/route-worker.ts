/**
 * Transport for the search: `route()` is a long synchronous loop, so it runs in
 * a worker where it cannot freeze the page, and reports progress as it goes.
 *
 * Halting is the main thread's `Worker#terminate()`: a worker stuck inside the
 * search cannot read a "stop" message, so there is nothing to negotiate.
 */
import route from "../app/route/route";
import type { RouteProgress, RouteStep, Spell } from "../app/route/route";

/** A search to run. `Spell[]` is plain data, so it survives structured cloning. */
export interface RouteRequest {
  spells: Spell[];
  goal: number;
  metamax: number;
  currentMagic: number;
  startingRefills: 0 | 1 | 2;
}

/** A finished search, flattened because a `RouteState` is a live object with methods. */
export interface RouteSnapshot {
  score: number;
  magic: number;
  spellIndex: number;
  pending: number;
  refills: number;
  bs: number;
  cf: boolean;
  ef: boolean;
  clot: boolean;
  /** The actions the best route takes, oldest first, each with the magic it leaves. */
  actions: RouteStep[];
  /** Time the search itself took, in milliseconds. */
  elapsed: number;
}

export type RouteWorkerMessage =
  | { kind: "progress"; progress: RouteProgress; elapsed: number }
  | { kind: "result"; result: RouteSnapshot }
  | { kind: "failure"; message: string; elapsed: number };

/** The part of the worker global this file uses; `lib.dom` types `self` as a window. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<RouteRequest>) => void) | null;
  postMessage(message: RouteWorkerMessage): void;
}

const scope = self as unknown as WorkerScope;

scope.onmessage = (event) => {
  const { spells, goal, metamax, currentMagic, startingRefills } = event.data;
  const startedAt = performance.now();

  try {
    const result = route({
      spells,
      goal,
      metamax,
      currentMagic,
      startingRefills,
      onProgress: (progress) => {
        scope.postMessage({ kind: "progress", progress, elapsed: performance.now() - startedAt });
      },
    });

    scope.postMessage({
      kind: "result",
      result: {
        score: result.currentValue(),
        magic: result.currentMagic,
        spellIndex: result.spellIndex,
        pending: result.pendingResolves.length,
        refills: result.refills,
        bs: result.bs,
        cf: result.cf,
        ef: result.ef,
        clot: result.clot,
        actions: result.history(),
        elapsed: performance.now() - startedAt,
      },
    });
  } catch (error) {
    scope.postMessage({
      kind: "failure",
      message: error instanceof Error ? error.message : String(error),
      elapsed: performance.now() - startedAt,
    });
  }
};
