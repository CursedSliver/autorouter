/**
 * Transport for the search: `route()` is a long synchronous loop, so it runs in
 * a worker where it cannot freeze the page, and reports progress as it goes.
 *
 * Halting is the main thread's `Worker#terminate()`: a worker stuck inside the
 * search cannot read a "stop" message, so there is nothing to negotiate.
 *
 * The worker also owns the polished instructions. `polish()` needs the live
 * `RouteState` chain, and importing the route core into the page would drag the
 * precomputed transmute tables onto the main thread, so the panel asks the worker
 * to re-polish whenever the assumed tower level changes.
 */
import route from "../app/route/route";
import type { RouteProgress, RouteState, RouteStep, Spell } from "../app/route/route";
import polish, { serializeInstructions } from "../app/route/polish";
import type { ComboInstructionsData } from "../app/route/polish";
import type { RawPlannerRow } from "../app/route/seedgen";
import { shorthandCombo } from "../lib/combo";

/** A search to run. `Spell[]` is plain data, so it survives structured cloning. */
export interface RouteRequest {
  spells: Spell[];
  /** The raw seed rows behind `spells`; null for a hand-typed queue. */
  rawSpells: RawPlannerRow[] | null;
  goal: number;
  metamax: number;
  currentMagic: number;
  startingRefills: 0 | 1 | 2;
  /** Which auras the route may lean on; a `true` flag assumes one is slotted. */
  restrictions: { siAllowed: boolean; rbAllowed: boolean };
  /** Tower level the instructions assume; 1 when the player did not say. */
  towerLevel: number;
  /** The most towers the player owns, the ceiling an instruction may ask for. */
  absMaxTowers: number;
  /** The game's spells-cast count when the route's first cast happens. */
  startCastCount: number;
}

/** A message the main thread sends to the worker. */
export type RouteWorkerRequest =
  | { kind: "route"; request: RouteRequest }
  | { kind: "polish"; towerLevel: number; absMaxTowers: number };

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
  | { kind: "result"; result: RouteSnapshot; instructions: ComboInstructionsData }
  | { kind: "polished"; instructions: ComboInstructionsData }
  | { kind: "failure"; message: string; elapsed: number };

/** The part of the worker global this file uses; `lib.dom` types `self` as a window. */
interface WorkerScope {
  onmessage: ((event: MessageEvent<RouteWorkerRequest>) => void) | null;
  postMessage(message: RouteWorkerMessage): void;
}

const scope = self as unknown as WorkerScope;

/**
 * The best route the last search reached, kept so the panel can re-polish it for
 * a different tower level without re-running the search. The combo shorthand and
 * the cast count are captured with it because they name the same result.
 */
let lastRoute: {
  state: RouteState;
  combo: string;
  startCastCount: number;
  rawSpells: RawPlannerRow[] | null;
} | null = null;

function instructionsFor(
  state: RouteState,
  towerLevel: number,
  startCastCount: number,
  absMaxTowers: number,
  rawSpells: RawPlannerRow[] | null,
  combo: string,
): ComboInstructionsData {
  try {
    return serializeInstructions(
      polish(state, towerLevel, startCastCount, absMaxTowers, rawSpells),
      towerLevel,
      combo,
    );
  } catch {
    // Instructions are a view of the route; a display-side failure must not turn a
    // valid result into a failed run, so fall back to the combo alone.
    return { combo, towerLevel, startRow: 0, actions: [] };
  }
}

scope.onmessage = (event) => {
  const message = event.data;

  if (message.kind === "polish") {
    if (lastRoute === null) return;

    scope.postMessage({
      kind: "polished",
      instructions: instructionsFor(
        lastRoute.state,
        message.towerLevel,
        lastRoute.startCastCount,
        message.absMaxTowers,
        lastRoute.rawSpells,
        lastRoute.combo,
      ),
    });

    return;
  }

  const {
    spells,
    rawSpells,
    goal,
    metamax,
    currentMagic,
    startingRefills,
    restrictions,
    towerLevel,
    absMaxTowers,
    startCastCount,
  } = message.request;
  const startedAt = performance.now();

  try {
    const result = route({
      spells,
      goal,
      metamax,
      currentMagic,
      startingRefills,
      restrictions,
      onProgress: (progress) => {
        scope.postMessage({ kind: "progress", progress, elapsed: performance.now() - startedAt });
      },
    });

    const instructions = instructionsFor(
      result,
      towerLevel,
      startCastCount,
      absMaxTowers,
      rawSpells,
      shorthandCombo(result),
    );
    lastRoute = { state: result, combo: instructions.combo, startCastCount, rawSpells };

    scope.postMessage({
      kind: "result",
      instructions,
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
