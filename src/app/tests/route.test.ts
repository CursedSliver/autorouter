/**
 * Scenario tests for the route core (`src/app/route/route.ts`).
 *
 * A scenario is a self-contained call to `route()` — a spell table plus its
 * metamax, starting magic and starting refills — together with the score the
 * search must return. `optimalBecause` records the argument for why no other
 * action sequence can score higher (the useful facts are: which effect a cast
 * can bank, what it costs, and how much magic the table can supply in total).
 *
 * Every scenario is additionally *replayed*: the action names are read back
 * off the returned state's parent chain, re-applied through `duplicate()` +
 * `act()`, and the replayed state must equal the reported one. That keeps a
 * scenario from passing on a score its own route cannot reach.
 *
 * The replay mirrors the engine's own step (`duplicate()` then `act()`), so it
 * also pins down what a step carries forward: effect flags, the clot penalty,
 * the di/diB backfire modifiers and the pending-resolve queue.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import route, { Actions, RouteState, SpellIndices, isNoop } from "../route/route";
import type { Action, Spell } from "../route/route";
import { createSpell } from "../../lib/spell";

/** Spell-table shorthand: flags in the name, gfd roll as the argument. */
const B = (gfdRs: number): Partial<Spell> => ({ bs: true, gfdRs });
const C = (gfdRs: number): Partial<Spell> => ({ cf: true, gfdRs });
const E = (gfdRs: number): Partial<Spell> => ({ ef: true, gfdRs });
const BC = (gfdRs: number): Partial<Spell> => ({ bs: true, cf: true, gfdRs });
const BCE = (gfdRs: number): Partial<Spell> => ({ bs: true, cf: true, ef: true, gfdRs });

/** Every case the scenario table has to cover at least once. */
const REQUIRED_COVERAGE = [
  "tiny",
  "overabundance",
  "small-metamax",
  "transmutation",
  "gfd-refund",
] as const;

interface Expected {
  score: number;
  bs: number;
  cf: boolean;
  ef: boolean;
  clot: boolean;
  /** How many queue entries the reported route consumes. */
  consumed: number;
  /** Minimum number of GFD resolves that refund their cast cost instead of paying the chain. */
  refunds?: number;
  /** Minimum number of GFD casts made with a max magic above the current magic. */
  transmutedGfdCasts?: number;
}

interface Scenario {
  name: string;
  covers: readonly string[];
  /** The table + resources: metamax / starting magic / starting refills. */
  metamax: number;
  currentMagic: number;
  refills: 0 | 1 | 2;
  spells: Partial<Spell>[];
  expected: Expected;
  /** Why no action sequence can beat `expected.score` for this input. */
  optimalBecause: string;
  /** The route the search currently reports, for the record. Not asserted: ties can reorder it. */
  route: string;
}

const SCENARIOS: readonly Scenario[] = [
  {
    name: "tiny-single-row",
    covers: ["tiny"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [B(0.5)],
    expected: { score: 1, bs: 1, cf: false, ef: false, clot: false, consumed: 1 },
    optimalBecause:
      "one queue entry banked at most once, and one fthof (115) is affordable; score <= 1",
    route: "fthof",
  },
  {
    name: "tiny-two-rows",
    covers: ["tiny"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    optimalBecause: "two bs rows, both fthofs affordable (115 + 54 <= 200), so score <= 2",
    spells: [B(0.5), B(0.5)],
    expected: { score: 2, bs: 2, cf: false, ef: false, clot: false, consumed: 2 },
    route: "fthof, fthof",
  },
  {
    name: "tiny-three-rows",
    covers: ["tiny"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [B(0.5), B(0.5), B(0.5)],
    expected: { score: 3, bs: 3, cf: false, ef: false, clot: false, consumed: 3 },
    optimalBecause:
      "three bs rows, all three fthofs affordable (115 + 54 + 25 = 194 <= 200), so score <= 3",
    route: "fthof, fthof, fthof",
  },
  {
    name: "backfiring-row-is-idle",
    covers: ["tiny", "backfire"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [B(0.9)],
    expected: { score: 0, bs: 0, cf: false, ef: false, clot: false, consumed: 0 },
    optimalBecause:
      "a roll above the backfire threshold means fthof can never bank bs (bs needs !backfires) and the row has no cf/ef, cbg can only add a clot penalty, so 0 is the best value and the idle state wins",
    route: "(none: acting costs magic and banks nothing)",
  },
  {
    name: "small-metamax-30",
    covers: ["small-metamax"],
    metamax: 30,
    currentMagic: 30,
    refills: 0,
    spells: [B(0.5), B(0.5), B(0.5)],
    expected: { score: 1, bs: 1, cf: false, ef: false, clot: false, consumed: 2 },
    optimalBecause:
      "a fthof only pays for itself at magic >= 19, and 30 magic buys one such cast (leaving < 13 needed for a second), so score <= 1",
    route: "cbg, fthof",
  },
  {
    name: "small-metamax-cf-beats-bs",
    covers: ["small-metamax"],
    metamax: 30,
    currentMagic: 30,
    refills: 0,
    spells: [BC(0.5), BC(0.5), BC(0.5), BC(0.5)],
    expected: { score: 1.5, bs: 0, cf: true, ef: false, clot: false, consumed: 2 },
    optimalBecause:
      "30 magic funds a single grant; cf (1.5) outranks bs (1), and a second grant needs >= 24 + 13 = 37 magic, so score <= 1.5",
    route: "cbg, fthof",
  },
  {
    name: "small-metamax-20",
    covers: ["small-metamax"],
    metamax: 20,
    currentMagic: 20,
    refills: 0,
    spells: [BC(0.5), BC(0.5), BC(0.5)],
    expected: { score: 1.5, bs: 0, cf: true, ef: false, clot: false, consumed: 1 },
    optimalBecause:
      "at metamax 20 a fthof (19) is the only affordable grant and leaves 1 magic, so one grant is the ceiling and cf beats bs",
    route: "fthof",
  },
  {
    name: "refills-split-the-table",
    covers: ["small-metamax", "refill"],
    metamax: 30,
    currentMagic: 30,
    refills: 2,
    spells: [B(0.5), B(0.5), B(0.5), B(0.5)],
    expected: { score: 3, bs: 3, cf: false, ef: false, clot: false, consumed: 4 },
    optimalBecause:
      "magic only refills up to metamax, so the table supplies three 30-magic chunks (30 + 30 + 30) and one chunk buys exactly one grant, so score <= 3",
    route: "cbg, fthof, refill, fthof, refill, fthof",
  },
  {
    name: "overabundance-bce",
    covers: ["overabundance"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [BCE(0.5), BCE(0.5), BCE(0.5), BCE(0.5)],
    expected: { score: 3.5, bs: 2, cf: true, ef: false, clot: false, consumed: 4 },
    optimalBecause:
      "a roll of 0.5 never backfires, so ef is unreachable; cf/bs come from fthof only (no g!fthof matches a 0.5 roll at any magic), four consecutive fthofs cost 115 + 54 + 25 + 13 > 200 so at most three can land, and the first grant is always cf, so score <= cf + 2bs = 3.5",
    route: "fthof, fthof, cbg, fthof",
  },
  {
    name: "overabundance-backfiring",
    covers: ["overabundance", "backfire"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [BCE(0.9), BCE(0.9), BCE(0.9)],
    expected: { score: 1.5, bs: 0, cf: false, ef: true, clot: false, consumed: 1 },
    optimalBecause:
      "a 0.9 roll always backfires, so an fthof grant is an ef grant; cf/bs need !backfires and di cannot rescue them, because di reads the row it consumes (0.9 backfires, so di becomes diB, which only sharpens backfires). ef is the only bankable effect, worth 1.5, and once it is banked later grants are worth nothing - so the route stops after the single fthof instead of paying for cbg consumes, which would also add a clot penalty that now persists",
    route: "fthof",
  },
  {
    name: "mixed-effects",
    covers: ["overabundance", "mixed"],
    metamax: 200,
    currentMagic: 200,
    refills: 0,
    spells: [B(0.5), C(0.5), B(0.5), E(0.9), B(0.5)],
    expected: { score: 4, bs: 1, cf: true, ef: true, clot: false, consumed: 5 },
    optimalBecause:
      "cf only exists on row 1 and ef only on row 3 (as a backfire), and a 0.5 roll never matches fthof in the GFD table, so grants are plain fthofs: three of them cost more than 200 magic, and the best three-grant pick is cf + ef + bs = 4",
    route: "cbg, fthof, g!se, fthof, resolve, fthof",
  },
  {
    name: "transmute-window-open",
    covers: ["transmutation", "variable-metamax"],
    metamax: 109,
    currentMagic: 40,
    refills: 0,
    spells: [B(0.3), B(0.3), B(0.3), B(0.3)],
    expected: {
      score: 2,
      bs: 2,
      cf: false,
      ef: false,
      clot: false,
      consumed: 4,
      refunds: 2,
      transmutedGfdCasts: 2,
    },
    optimalBecause:
      "the input supplies 40 magic and two fthof grants cost 23 (at magic 27) + 17 (at magic 17) = 40, so both row-consuming casts have to be net free. The free consume is g!ra, whose resolve hands the cast cost back, and at magic 40 the ra slot only appears at max 109 - reachable only by casting above the current max magic. metamax 109 is the first metamax that opens that window; see transmute-window-closed",
    route: "g!ra, g!ra, fthof, resolve, resolve, fthof",
  },
  {
    name: "transmute-window-closed",
    covers: ["transmutation", "variable-metamax"],
    metamax: 100,
    currentMagic: 40,
    refills: 0,
    spells: [B(0.3), B(0.3), B(0.3), B(0.3)],
    expected: {
      score: 1,
      bs: 1,
      cf: false,
      ef: false,
      clot: false,
      consumed: 2,
      refunds: 0,
      transmutedGfdCasts: 0,
    },
    optimalBecause:
      "the same table and resources as transmute-window-open, one point of metamax lower: the ra slot starts at max 109, i.e. just outside the window, so no consume can be free and the 40 magic buys a single grant",
    route: "cbg, fthof",
  },
  {
    name: "gfd-refund-default-metamax",
    covers: ["gfd-refund"],
    metamax: 200,
    currentMagic: 40,
    refills: 0,
    spells: [B(0.3), B(0.3), B(0.3), B(0.3)],
    expected: {
      score: 2,
      bs: 2,
      cf: false,
      ef: false,
      clot: false,
      consumed: 4,
      refunds: 2,
      transmutedGfdCasts: 2,
    },
    optimalBecause:
      "two fthof grants cost 23 (at magic 27) + 17 (at magic 17) = 40, the entire pool, so no magic is left for consuming rows 2 and 3 and the consumes have to pay for themselves: g!ra resolves hand the cast cost back, and reaching the ra slot at magic 40 means transmuting to max 109",
    route: "g!ra, g!ra, fthof, resolve, resolve, fthof",
  },
  {
    name: "gfd-refund-variable-metamax",
    covers: ["gfd-refund", "variable-metamax"],
    metamax: 120,
    currentMagic: 40,
    refills: 0,
    spells: [BC(0.3), BC(0.3), BC(0.3), BC(0.3)],
    expected: {
      score: 2.5,
      bs: 1,
      cf: true,
      ef: false,
      clot: false,
      consumed: 4,
      refunds: 2,
      transmutedGfdCasts: 2,
    },
    optimalBecause:
      "the cf-carrying version of gfd-refund-default-metamax, at metamax 120 instead of 200: the same two refunded g!ra consumes fund the two fthofs (23 + 17), and fthof banks cf (1.5) before bs (1), so the route is worth 2.5",
    route: "g!ra, g!ra, fthof, resolve, resolve, fthof",
  },
  {
    name: "max-grants-with-one-refill",
    covers: ["variable-metamax", "max-score"],
    metamax: 200,
    currentMagic: 200,
    refills: 1,
    spells: [B(0.5), B(0.5), B(0.5), B(0.5)],
    expected: { score: 4, bs: 4, cf: false, ef: false, clot: false, consumed: 4 },
    optimalBecause:
      "the table ceiling: four rows, four grants, nothing worth more than 1 here. Three fthofs drain the pool to 6, where the fourth would cost 13, so the single refill is what closes the table - it lifts 6 magic to 106 and the last fthof (65) lands",
    route: "fthof, fthof, fthof, refill, fthof",
  },
];

const actionByName = new Map<string, Action>(Actions.map((action) => [action.name, action]));

/** `route()` logs a global step counter; keep the test output readable. */
function runRoute(scenario: Scenario, stepLimit?: number): RouteState {
  const spells = scenario.spells.map((spell) => createSpell(spell));
  const log = console.log;
  console.log = () => {};
  try {
    return route({
      spells,
      goal: 1,
      metamax: scenario.metamax,
      currentMagic: scenario.currentMagic,
      startingRefills: scenario.refills,
      ...(stepLimit === undefined ? {} : { stepLimit }),
    });
  } finally {
    console.log = log;
  }
}

interface Snapshot {
  value: number;
  magic: number;
  bs: number;
  cf: boolean;
  ef: boolean;
  clot: boolean;
  refills: number;
  pending: number;
  spellIndex: number;
}

function snap(state: RouteState): Snapshot {
  return {
    value: state.currentValue(),
    magic: state.currentMagic,
    bs: state.bs,
    cf: state.cf,
    ef: state.ef,
    clot: state.clot,
    refills: state.refills,
    pending: state.pendingResolves.length,
    spellIndex: state.spellIndex,
  };
}

/** Action names along the returned state's parent chain, oldest first. */
function routeNames(state: RouteState): string[] {
  const names: string[] = [];
  let node: RouteState | null = state;
  while (node !== null && node.parent !== null) {
    const action = node.action;
    assert.ok(action !== null, "a non-root state must record which action produced it");
    names.push(action);
    node = node.parent;
  }
  return names.reverse();
}

/** What the g! actions advertise through `able()` at the current magic (see `getCost(3, 0.05)`). */
const advertisedGfdCost = (magic: number): number => Math.floor(0.89 * (3 + 0.05 * magic));

interface ReplayStep {
  name: string;
  before: Snapshot;
  after: Snapshot;
  /** Magic the action itself took out of the pool (GFD casts spend their own cast cost). */
  castCost: number;
  /** `castCost` above what `able()` advertises proves the cast went above the current max magic. */
  transmuted: boolean;
  /** For `resolve`: whether the pending GFD paid its chain or refunded the cast cost. */
  settlement: "paid" | "refunded" | null;
}

interface Replay {
  final: RouteState;
  steps: ReplayStep[];
  refunds: number;
  transmutedCasts: number;
}

function replayRoute(scenario: Scenario, result: RouteState): Replay {
  const spells = scenario.spells.map((spell) => createSpell(spell));
  let node = new RouteState(
    null,
    spells,
    scenario.currentMagic,
    0,
    scenario.metamax,
    scenario.refills,
  );
  const steps: ReplayStep[] = [];

  for (const name of routeNames(result)) {
    const action = actionByName.get(name);
    assert.ok(action !== undefined, `reported route uses unknown action "${name}"`);
    const before = snap(node);
    const pending = node.pendingResolves[0];

    assert.ok(action.able(node), `reported route takes "${name}" while it is not legal`);

    // The search builds every node as duplicate() + act(); mirror that exactly.
    const next = node.duplicate();
    assert.ok(next.act(action), `"${name}" cancelled when replayed`);
    assert.ok(
      !isNoop(node, next),
      `"${name}" does not change the state and should have been skipped`,
    );

    const after = snap(next);
    let settlement: ReplayStep["settlement"] = null;
    if (name === "resolve" && pending !== undefined) {
      const delta = after.magic - before.magic;
      if (pending.spell === SpellIndices.RA || pending.spell === SpellIndices.SE) {
        assert.equal(delta, pending.gfdCost, "a resolved ra/se returns its cast cost");
        settlement = "refunded";
      } else if (before.magic < pending.chainCost) {
        assert.equal(delta, pending.gfdCost, "an unaffordable chain refunds the cast cost");
        settlement = "refunded";
      } else {
        assert.equal(delta, -pending.chainCost, "an affordable chain is paid on resolve");
        settlement = "paid";
      }
    }

    const castCost = name.startsWith("g!") ? before.magic - after.magic : 0;
    steps.push({
      name,
      before,
      after,
      castCost,
      transmuted: name.startsWith("g!") && castCost > advertisedGfdCost(before.magic),
      settlement,
    });
    node = next;
  }

  return {
    final: node,
    steps,
    refunds: steps.filter((step) => step.settlement === "refunded").length,
    transmutedCasts: steps.filter((step) => step.transmuted).length,
  };
}

function scenarioNamed(name: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  assert.ok(scenario !== undefined, `no scenario named ${name}`);
  return scenario;
}

describe("route(): scenarios", () => {
  for (const scenario of SCENARIOS) {
    it(`${scenario.name} (${scenario.covers.join(", ")})`, () => {
      const started = performance.now();
      const result = runRoute(scenario);
      const elapsed = performance.now() - started;

      // A truncated search is a different claim than an optimal one, so
      // every scenario here has to finish inside the step budget.
      assert.equal(result.currentValue(), scenario.expected.score, "score");
      assert.equal(result.bs, scenario.expected.bs, "banked bs");
      assert.equal(result.cf, scenario.expected.cf, "banked cf");
      assert.equal(result.ef, scenario.expected.ef, "banked ef");
      assert.equal(result.clot, scenario.expected.clot, "clot");
      assert.equal(result.spellIndex, scenario.expected.consumed, "queue entries consumed");
      assert.ok(elapsed < 2_000, `search took ${elapsed.toFixed(0)}ms (budget is well under 0.5s)`);

      const replay = replayRoute(scenario, result);
      assert.deepEqual(
        snap(replay.final),
        snap(result),
        "the reported state is not reachable by its own route",
      );

      if (scenario.expected.refunds !== undefined) {
        assert.ok(
          replay.refunds >= scenario.expected.refunds,
          `expected at least ${scenario.expected.refunds} GFD refund(s), saw ${replay.refunds}`,
        );
      }

      if (scenario.expected.transmutedGfdCasts !== undefined) {
        assert.ok(
          replay.transmutedCasts >= scenario.expected.transmutedGfdCasts,
          `expected at least ${scenario.expected.transmutedGfdCasts} above-current-max GFD cast(s), saw ${replay.transmutedCasts}`,
        );
      }
    });
  }
});

describe("route(): scenario coverage", () => {
  it("covers every required case", () => {
    for (const tag of REQUIRED_COVERAGE) {
      const covering = SCENARIOS.filter((scenario) => scenario.covers.includes(tag));
      assert.ok(covering.length > 0, `no scenario covers "${tag}"`);
    }
  });

  it("keeps every table below seven spells", () => {
    for (const scenario of SCENARIOS) {
      assert.ok(
        scenario.spells.length < 7,
        `${scenario.name} has ${scenario.spells.length} spells`,
      );
    }
  });

  it("has unique scenario names", () => {
    const names = new Set(SCENARIOS.map((scenario) => scenario.name));
    assert.equal(names.size, SCENARIOS.length);
  });
});

describe("route(): state and action contracts", () => {
  it("scores bs + 1.5 cf + 1.5 ef - 0.1 clot", () => {
    const state = new RouteState(null, [], 0, 0, 200, 0);
    assert.equal(state.currentValue(), 0);

    state.addBuff("clot");
    assert.ok(Math.abs(state.currentValue() - -0.1) < 1e-9);

    state.addBuff("bs");
    state.addBuff("bs");
    state.addBuff("cf");
    state.addBuff("ef");
    assert.ok(Math.abs(state.currentValue() - 4.9) < 1e-9, "2 bs + cf + ef - clot");
  });

  it("is deterministic: the same input yields the same route", () => {
    const scenario = scenarioNamed("mixed-effects");
    const first = runRoute(scenario);
    const second = runRoute(scenario);
    assert.deepEqual(snap(second), snap(first));
    assert.deepEqual(routeNames(second), routeNames(first));
  });

  it("cancels a GFD that cannot reach its spell instead of spending magic", () => {
    // At (magic 200, metamax 200, roll 0.5) the precomputed pool maps the
    // roll onto a single spell slot. Whatever that slot is, the other seven
    // g! variants have to report cancellation: no magic, no queue movement.
    const state = new RouteState(null, [createSpell(B(0.5))], 200, 0, 200, 0);
    const before = snap(state);
    const matched: string[] = [];
    let cancelled = 0;

    for (const action of Actions.filter((candidate) => candidate.name.startsWith("g!"))) {
      const probe = state.duplicate();
      if (probe.act(action) && probe.spellIndex !== state.spellIndex) {
        matched.push(action.name);
        assert.equal(
          probe.pendingResolves.length,
          1,
          "a matching g! cast queues exactly one resolve",
        );
      } else {
        cancelled += 1;
      }
    }

    // The precomputed pool maps a roll onto one slot, and that slot is the
    // spell index (cbg 0 ... di 7). The pool at max magic holds every spell,
    // so a roll of 0.5 selects count 4 - the fifth set bit counting down from
    // bit 7 - which is bit 3, i.e. `se`. The other seven variants have to
    // cancel rather than spend magic.
    assert.deepEqual(matched, ["g!se"]);
    assert.equal(cancelled, 7);
    assert.deepEqual(snap(state), before, "probing with duplicate() must not mutate the state");
  });

  it("keeps refills legal only while charges remain and magic is below the cap", () => {
    const refill = actionByName.get("refill");
    assert.ok(refill !== undefined);

    const atCap = new RouteState(null, [], 30, 0, 30, 2);
    assert.equal(refill.able(atCap), false, "a refill at metamax spends a charge for nothing");

    const empty = new RouteState(null, [], 0, 0, 30, 2);
    assert.equal(refill.able(empty), true);
    assert.ok(empty.act(refill));
    assert.equal(empty.currentMagic, 30, "a refill clamps to metamax");
    assert.equal(empty.refills, 1);

    const spent = new RouteState(null, [], 0, 0, 30, 0);
    assert.equal(refill.able(spent), false, "no charges left");
  });

  it("duplicates every field the search relies on, without sharing mutable data", () => {
    const source = new RouteState(null, [], 100, 2, 200, 1);
    source.addBuff("bs");
    source.addBuff("cf");
    source.addBuff("ef");
    source.addBuff("clot");
    source.addBuff("di");
    source.addResolve(7, 33.5, SpellIndices.FTHOF);

    const copy = source.duplicate();
    assert.equal(copy.parent, source);
    assert.equal(copy.currentMagic, 100);
    assert.equal(copy.spellIndex, 2);
    assert.equal(copy.metamax, 200);
    assert.equal(copy.refills, 1);
    assert.equal(copy.bs, 1);
    assert.equal(copy.cf, true);
    assert.equal(copy.ef, true);
    assert.equal(copy.clot, true, "the clot penalty carries into descendants");
    assert.equal(copy.di, true, "the di backfire modifier carries into descendants");
    assert.equal(copy.diB, false);

    copy.addBuff("diB");
    assert.equal(copy.di, false);
    assert.equal(copy.diB, true, "di and diB are mutually exclusive");
    assert.equal(source.di, true, "mutating a copy must not flip the source's buff");
    assert.notEqual(
      copy.pendingResolves,
      source.pendingResolves,
      "pending queue must not be shared",
    );
    assert.deepEqual(copy.pendingResolves, source.pendingResolves);

    copy.pendingResolves.push({ gfdCost: 1, chainCost: 1, spell: SpellIndices.CBG });
    assert.equal(source.pendingResolves.length, 1, "mutating a copy must not touch the source");
  });
});
