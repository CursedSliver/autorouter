/**
 * Contract tests for the micro-router bound (`src/app/route/microrouter.ts`) and
 * for the way `route.ts` consumes it (`initializeValueEvaluationList` /
 * `currentMaxValue`).
 *
 * The micro-router answers a narrower question than `route()`: with infinite
 * magic and arbitrary transmutes, how much score is reachable from row `r` when
 * `k` g!fthof resolves are already pending, for every combination of buffs the
 * route already holds (`existing`) and golden/wrath cookies it is committed to
 * leaving on screen (`toKeep`). The answer is a table
 * `bounds[row][pendingFthofs][type]`.
 *
 * The conventions this suite pins down, all derived from `RouteState`:
 *
 * - A plain cast backfires when `roll > 1 - failChance` (so a *low* roll
 *   succeeds); a g! resolve uses `backfiresGFD`, whose backfire ceiling is
 *   capped at `0.5`.
 * - The fail chance for Force the Hand of Fate grows by `0.15` per golden/wrath
 *   cookie on screen, and `toKeep` means those cookies cannot be clicked, so
 *   `minOnscreens` is a mandatory, monotonically growing floor.
 * - `bs` scores 1 and stacks; `cf` scores 1.4 and `ef` 1.3, and both are
 *   one-shot (their scores zero out once held).
 * - `resolve-*` settles a pending g!fthof without consuming the row, so a row's
 *   `bs` can be paid by a resolve and then again by a direct cast.
 *
 * Table/property tests are preferred over worked examples where a rule has a
 * shape (all 16 types, all rows, all pending slots); pinned numbers are used
 * where the interaction is the point.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import routeBounds, {
  PossibleEvaluations,
  RouteBoundState,
  SimpleActions,
} from "../route/microrouter";
import type { SimpleAction } from "../route/microrouter";
import { RouteState, SpellIndices } from "../route/route";
import type { Spell } from "../route/route";
import { createSpell } from "../../lib/spell";

/* -------------------------------------------------------------------------- *
 * Helpers
 * -------------------------------------------------------------------------- */

/** The two halves of a `PossibleEvaluations` key: existing buffs - kept onscreens. */
const TYPE_PARTS = ["", "cf", "ef", "cfef"] as const;
type TypePart = (typeof TYPE_PARTS)[number];

const typeKey = (existing: TypePart, toKeep: TypePart): PossibleEvaluations =>
  `${existing}-${toKeep}` as PossibleEvaluations;

/** Every key the table builder can produce, and every key the enum must define. */
const ALL_TYPES: PossibleEvaluations[] = TYPE_PARTS.flatMap((existing) =>
  TYPE_PARTS.map((toKeep) => typeKey(existing, toKeep)),
);

/**
 * Mirrors `RouteBoundState`'s constructor: a cookie the route already holds and
 * is committed to keeping is on screen from the start, so it counts once.
 */
function mandatoryOnscreens(type: PossibleEvaluations): number {
  const [existing = "", toKeep = ""] = type.split("-");
  return (
    (existing.includes("cf") && toKeep.includes("cf") ? 1 : 0) +
    (existing.includes("ef") && toKeep.includes("ef") ? 1 : 0)
  );
}

/**
 * Mirrors `RouteBoundState#possibleToSucceed`: the highest roll that can still
 * succeed at this many mandatory onscreens. The expression is written the same
 * way the class writes it so the boundary is bit-identical.
 */
const successCeiling = (onscreens: number): number => 1 - 0.015 - 0.15 * onscreens;

/** g!fthof's roll window: the ranges where FTHOF can be the transmute target. */
const GFD_FTHOF_MIN = 0.125;
const GFD_FTHOF_MAX = 1 / 3;

const canCastGfthof = (spell: Spell): boolean =>
  spell.gfdRs >= GFD_FTHOF_MIN && spell.gfdRs < GFD_FTHOF_MAX;

/** How many g!fthof sources a table row reserves pending-resolve slots for. */
const prefixGfthofs = (spells: readonly Spell[], endExclusive: number): number =>
  spells.slice(0, endExclusive).filter(canCastGfthof).length;

/** Spell-table shorthand: the flag in the constructor, the roll as the argument. */
const BS = (gfdRs: number): Spell => createSpell({ bs: true, gfdRs });
const CF = (gfdRs: number): Spell => createSpell({ cf: true, gfdRs });
const EF = (gfdRs: number): Spell => createSpell({ ef: true, gfdRs });
/** A row that only exists as a g!fthof source: no effects of its own. */
const G = (gfdRs: number): Spell => createSpell({ gfdRs });

type BoundTable = Record<PossibleEvaluations, number>[][];

/** The bound for one (row, pending g!fthofs, type) cell, with shape checks. */
function bound(table: BoundTable, row: number, gfthofs: number, type: PossibleEvaluations): number {
  const slots = table[row];
  assert.ok(slots !== undefined, `the table has no row ${row}`);
  const cell = slots[gfthofs];
  assert.ok(cell !== undefined, `row ${row} has no pending-resolve slot ${gfthofs}`);
  const value = cell[type];
  assert.equal(typeof value, "number", `row ${row} slot ${gfthofs} type ${type}`);

  return value;
}

/** The whole record for one (row, pending g!fthofs) cell. */
function boundCell(
  table: BoundTable,
  row: number,
  gfthofs: number,
): Record<PossibleEvaluations, number> {
  const slots = table[row];
  assert.ok(slots !== undefined, `the table has no row ${row}`);
  const cell = slots[gfthofs];
  assert.ok(cell !== undefined, `row ${row} has no pending-resolve slot ${gfthofs}`);

  return cell;
}

/* -------------------------------------------------------------------------- *
 * routeBounds(): table shape
 * -------------------------------------------------------------------------- */

describe("routeBounds(): table shape", () => {
  it("returns an empty table for an empty queue", () => {
    assert.deepEqual(routeBounds([]), []);
  });

  it("has one row per spell and one pending slot per prefix g!fthof source", () => {
    const spells = [G(0.2), BS(0.5), G(0.3), CF(0.4), EF(0.99)];
    const table = routeBounds(spells);

    assert.equal(table.length, spells.length);
    for (let row = 0; row < spells.length; row++) {
      const slots = table[row];
      assert.ok(slots !== undefined);
      assert.equal(
        slots.length,
        prefixGfthofs(spells, row) + 1,
        `row ${row} reserves slots for every g!fthof source strictly before it`,
      );
    }
  });

  it("gives row 0 a single all-zero-pending slot even when it is a g!fthof source", () => {
    const table = routeBounds([G(0.2), BS(0.2)]);

    assert.equal(table[0]?.length, 1, "nothing has been cast before the first row");
    assert.equal(table[1]?.length, 2, "the g!fthof on row 0 can be pending at row 1");
  });

  it("gates the pending dimension on the same window as g!fthof itself", () => {
    const justOutside = routeBounds([G(GFD_FTHOF_MIN - 0.001), BS(0.2)]);
    const atFloor = routeBounds([G(GFD_FTHOF_MIN), BS(0.2)]);
    const atCeiling = routeBounds([G(GFD_FTHOF_MAX), BS(0.2)]);

    assert.equal(justOutside[1]?.length, 1, "below the window there is nothing to resolve");
    assert.equal(atFloor[1]?.length, 2, "0.125 is inside the window");
    assert.equal(atCeiling[1]?.length, 1, "1/3 is outside the half-open window");
  });

  it("defines exactly the 16 keys the builder can produce, with finite scores", () => {
    assert.deepEqual(
      Object.keys(PossibleEvaluations).sort(),
      [...ALL_TYPES].sort(),
      "every (existing, toKeep) combination must have an enum member",
    );

    const spells = [G(0.2), BS(0.2), CF(0.5)];
    const table = routeBounds(spells);
    for (let row = 0; row < table.length; row++) {
      for (let gfthofs = 0; gfthofs < table[row]!.length; gfthofs++) {
        const cell = boundCell(table, row, gfthofs);
        for (const type of ALL_TYPES) {
          assert.ok(Number.isFinite(cell[type]), `row ${row} slot ${gfthofs} ${type} is finite`);
          assert.ok(cell[type] >= 0, `row ${row} slot ${gfthofs} ${type} is non-negative`);
        }
      }
    }
  });

  it("does not touch the queue it was given and returns fresh tables", () => {
    const spells = [G(0.2), BS(0.2), EF(0.9)];
    const before = spells.map((spell) => ({ ...spell }));

    const first = routeBounds(spells);
    const second = routeBounds(spells);

    assert.deepEqual(spells, before, "the queue must not be mutated");
    assert.deepEqual(second, first, "the bound is deterministic");
    assert.notEqual(second, first, "each call owns its table");
    assert.notEqual(second[0], first[0], "each call owns its rows too");
  });
});

/* -------------------------------------------------------------------------- *
 * routeBounds(): score model
 * -------------------------------------------------------------------------- */

describe("routeBounds(): score model", () => {
  it("scores a plain cast as bs 1, cf 1.4 and ef 1.3", () => {
    assert.equal(bound(routeBounds([BS(0.5)]), 0, 0, typeKey("", "")), 1);
    assert.equal(bound(routeBounds([CF(0.5)]), 0, 0, typeKey("", "")), 1.4);
    assert.equal(bound(routeBounds([EF(0.5)]), 0, 0, typeKey("", "")), 1.3);
  });

  it("accumulates across independent rows", () => {
    assert.equal(bound(routeBounds([BS(0.2), BS(0.3), CF(0.4)]), 0, 0, typeKey("", "")), 3.4);
  });

  it("lets bs stack but keeps cf and ef one-shot", () => {
    assert.equal(bound(routeBounds([BS(0.2), BS(0.2), BS(0.2)]), 0, 0, typeKey("", "")), 3);

    // A second cf is worth nothing: the first one zeroes `cfScore` and the
    // direct action refuses to run without a score to pay.
    assert.equal(bound(routeBounds([CF(0.2), CF(0.2)]), 0, 0, typeKey("", "")), 1.4);
    assert.equal(bound(routeBounds([EF(0.2), EF(0.2)]), 0, 0, typeKey("", "")), 1.3);
  });

  it("ignores dfBs, which the search does not model yet", () => {
    const dfOnly = createSpell({ dfBs: true, gfdRs: 0.2 });
    assert.equal(bound(routeBounds([dfOnly]), 0, 0, typeKey("", "")), 0);
  });

  it("scores nothing on a row with no effects", () => {
    const table = routeBounds([G(0.5)]);
    for (const type of ALL_TYPES) {
      assert.equal(bound(table, 0, 0, type), 0, type);
    }
  });
});

/* -------------------------------------------------------------------------- *
 * routeBounds(): the success threshold and mandatory onscreens
 * -------------------------------------------------------------------------- */

describe("routeBounds(): success threshold and mandatory onscreens", () => {
  it("takes bs from a roll inside the plain-cast success window", () => {
    assert.equal(bound(routeBounds([BS(0.98)]), 0, 0, typeKey("", "")), 1, "0.98 <= 0.985");
    assert.equal(bound(routeBounds([BS(0.99)]), 0, 0, typeKey("", "")), 0, "0.99 > 0.985");
  });

  it("gates cf the same way and leaves ef ungated, since ef is the backfire buff", () => {
    assert.equal(bound(routeBounds([CF(0.99)]), 0, 0, typeKey("", "")), 0, "cf needs a success");
    assert.equal(bound(routeBounds([EF(0.99)]), 0, 0, typeKey("", "")), 1.3, "ef is a backfire");
  });

  it("raises the bar for every cookie the route is committed to keeping", () => {
    // One bs row, and the mandatory onscreen count each type implies.
    const table = routeBounds([BS(0.9)]);

    for (const type of ALL_TYPES) {
      const expected = 0.9 <= successCeiling(mandatoryOnscreens(type)) ? 1 : 0;
      assert.equal(bound(table, 0, 0, type), expected, type);
    }

    // The distribution is what makes the case discriminating: 9 types keep no
    // cookie, 6 keep one, and only `cfef-cfef` keeps both.
    const counts = new Map<number, number>();
    for (const type of ALL_TYPES) {
      const k = mandatoryOnscreens(type);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    assert.deepEqual(
      counts,
      new Map([
        [0, 9],
        [1, 6],
        [2, 1],
      ]),
    );
  });

  it("only counts a kept cookie when the buff is already held", () => {
    // `toKeep` alone is not enough: keeping a cookie the route has not earned
    // yet is not forced, so the mandatory count stays 0 and 0.9 still succeeds.
    assert.equal(bound(routeBounds([BS(0.9)]), 0, 0, typeKey("", "cf")), 1);
    assert.equal(bound(routeBounds([BS(0.9)]), 0, 0, typeKey("", "cfef")), 1);
    // Holding cf and committing to keep it starts the route one cookie up.
    assert.equal(bound(routeBounds([BS(0.9)]), 0, 0, typeKey("cf", "cf")), 0);
  });

  it("keeps a held cf or ef worth nothing", () => {
    const table = routeBounds([BS(0.5), CF(0.5), EF(0.5)]);
    assert.equal(bound(table, 0, 0, typeKey("", "")), 3.7);
    assert.equal(bound(table, 0, 0, typeKey("cf", "")), 2.3, "cf is already held");
    assert.equal(bound(table, 0, 0, typeKey("ef", "")), 2.4, "ef is already held");
    assert.equal(bound(table, 0, 0, typeKey("cfef", "")), 1, "only the bs is still worth anything");
  });

  it("never scores more for a stricter toKeep (mandatory onscreens only ever hurt)", () => {
    const corpus: Spell[][] = [
      [BS(0.5), CF(0.9)],
      [G(0.2), BS(0.2)],
      [G(0.2), CF(0.4), EF(0.9)],
      [BS(0.9), EF(0.99), CF(0.6)],
      [CF(0.125), BS(0.2), G(0.3)],
    ];

    for (const spells of corpus) {
      const table = routeBounds(spells);
      for (let row = 0; row < table.length; row++) {
        for (let gfthofs = 0; gfthofs < table[row]!.length; gfthofs++) {
          for (const existing of TYPE_PARTS) {
            const base = bound(table, row, gfthofs, typeKey(existing, ""));
            for (const toKeep of TYPE_PARTS) {
              assert.ok(
                bound(table, row, gfthofs, typeKey(existing, toKeep)) <= base,
                `${typeKey(existing, toKeep)} must not beat ${typeKey(existing, "")} at row ${row}`,
              );
            }
          }
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- *
 * routeBounds(): g!fthof and resolve
 * -------------------------------------------------------------------------- */

describe("routeBounds(): g!fthof and resolve", () => {
  /** A g!fthof source followed by a row worth `score`, with no magic in the way. */
  const viaGfthof = (roll: number, spells: Spell[]): number =>
    bound(routeBounds([G(roll), ...spells]), 0, 0, typeKey("", ""));

  it("opens the g!fthof action only inside the transmute window", () => {
    // Taking row 1's bs twice: once through the queued resolve, once through a
    // direct cast, is worth 2. Anything the g!fthof cannot be cast on scores 1.
    assert.equal(viaGfthof(GFD_FTHOF_MIN - 0.001, [BS(0.2)]), 1, "below the window");
    assert.equal(viaGfthof(GFD_FTHOF_MIN, [BS(0.2)]), 2, "0.125 is inside the window");
    assert.equal(viaGfthof(0.33, [BS(0.2)]), 2, "just below 1/3");
    assert.equal(viaGfthof(GFD_FTHOF_MAX, [BS(0.2)]), 1, "1/3 is outside the half-open window");
  });

  it("needs a pending resolve before a resolve action can fire", () => {
    // No g!fthof source, so the bs is only reachable by a direct cast.
    assert.equal(bound(routeBounds([BS(0.2)]), 0, 0, typeKey("", "")), 1);
    // A pre-supplied pending resolve on a bs row is worth one extra bs.
    const table = routeBounds([G(0.2), BS(0.2)]);
    assert.equal(bound(table, 1, 0, typeKey("", "")), 1, "no pending, direct cast only");
    assert.equal(bound(table, 1, 1, typeKey("", "")), 2, "one pending resolve, then the cast");
  });

  it("pays a resolved row twice for bs because resolve does not consume the row", () => {
    const table = routeBounds([G(0.2), BS(0.2)]);

    assert.equal(bound(table, 0, 0, typeKey("", "")), 2);
    assert.equal(
      bound(table, 1, 1, typeKey("", "")),
      2,
      "starting at the bs row with the resolve already queued is the same 2",
    );
  });

  it("cannot pay a resolved row twice for cf or ef", () => {
    // The resolve takes the buff and zeroes its score, so the follow-up direct
    // cast has nothing left to collect.
    assert.equal(bound(routeBounds([G(0.2), CF(0.2)]), 0, 0, typeKey("", "")), 1.4);
    assert.equal(bound(routeBounds([G(0.2), EF(0.2)]), 0, 0, typeKey("", "")), 1.3);
  });

  it("gates a g! resolve's success at roll 0.5, the backfiresGFD ceiling", () => {
    const at = (roll: number): number =>
      bound(routeBounds([G(0.2), BS(roll)]), 0, 0, typeKey("", ""));

    assert.equal(at(0.4), 2, "inside the capped success window");
    assert.equal(at(0.5), 1, "0.5 is a backfire for a g! resolve");
    assert.equal(at(0.6), 1, "above the cap, only the direct cast is left");
  });

  it("banks every queued resolve before the row is consumed", () => {
    // Two g!fthof sources queue two resolves, and the bs row can absorb both
    // before a direct cast closes the queue out.
    const table = routeBounds([G(0.2), G(0.3), BS(0.2)]);

    assert.equal(bound(table, 0, 0, typeKey("", "")), 3);
    assert.equal(bound(table, 2, 2, typeKey("", "")), 3, "same route, seen from the bs row");
    assert.equal(bound(table, 2, 1, typeKey("", "")), 2);
    assert.equal(bound(table, 2, 0, typeKey("", "")), 1);
  });

  it("cannot pay for a row whose effect is missing", () => {
    // A resolve strictly consumes a pending g!fthof, so it is only worth
    // spending on a row that pays. An empty row in between is skipped instead.
    const table = routeBounds([G(0.2), G(0.3), BS(0.2)]);
    assert.equal(
      bound(table, 1, 0, typeKey("", "")),
      2,
      "skip the empty row, then one resolve and one cast",
    );
    assert.equal(bound(table, 1, 1, typeKey("", "")), 3, "queue one more source first");
  });
});

/* -------------------------------------------------------------------------- *
 * routeBounds(): invariants over a small corpus
 * -------------------------------------------------------------------------- */

describe("routeBounds(): invariants over a small corpus", () => {
  const CORPUS: Spell[][] = [
    [BS(0.2)],
    [BS(0.5), CF(0.9)],
    [G(0.2), BS(0.2)],
    [G(0.2), CF(0.4), EF(0.9)],
    [G(0.2), G(0.3), BS(0.4), CF(0.6)],
    [BS(0.99), EF(0.99), CF(0.99)],
    [CF(GFD_FTHOF_MIN), G(GFD_FTHOF_MAX), BS(0.2), G(0.3)],
  ];
  const tables = CORPUS.map((spells) => routeBounds(spells));

  it("is monotone in the row: starting earlier can only add options", () => {
    CORPUS.forEach((spells, index) => {
      const table = tables[index]!;
      for (let row = 0; row + 1 < spells.length; row++) {
        for (let gfthofs = 0; gfthofs < table[row]!.length; gfthofs++) {
          for (const type of ALL_TYPES) {
            if (gfthofs >= table[row + 1]!.length) continue;
            assert.ok(
              bound(table, row, gfthofs, type) >= bound(table, row + 1, gfthofs, type),
              `row ${row} must not be worse than row ${row + 1} for ${type}`,
            );
          }
        }
      }
    });
  });

  it("is monotone in pending resolves: a queued resolve is an option, never a cost", () => {
    CORPUS.forEach((spells, index) => {
      const table = tables[index]!;
      for (let row = 0; row < spells.length; row++) {
        for (let gfthofs = 1; gfthofs < table[row]!.length; gfthofs++) {
          for (const type of ALL_TYPES) {
            assert.ok(
              bound(table, row, gfthofs, type) >= bound(table, row, gfthofs - 1, type),
              `row ${row} with ${gfthofs} pending must not be worse than ${gfthofs - 1}`,
            );
          }
        }
      }
    });
  });

  it("never undershoots the route that takes every reachable bs directly", () => {
    // With no kept cookies the search can walk the whole queue, cast on every
    // row whose bs can still succeed and skip the rest, so the bound must be at
    // least that. An undershoot here would prune a legal route.
    CORPUS.forEach((spells, index) => {
      const table = tables[index]!;
      const directBs = spells.reduce(
        (sum, spell) => sum + (spell.bs && spell.gfdRs <= successCeiling(0) ? 1 : 0),
        0,
      );

      assert.ok(
        bound(table, 0, 0, typeKey("", "")) >= directBs,
        `corpus ${index}: the bound must cover at least ${directBs} direct bs`,
      );
    });
  });
});

/* -------------------------------------------------------------------------- *
 * RouteBoundState: construction and purification
 * -------------------------------------------------------------------------- */

describe("RouteBoundState: construction and purification", () => {
  const spells = [BS(0.5), CF(0.5), EF(0.5)];

  it("starts a plain route with every score available and nothing forced on screen", () => {
    const state = new RouteBoundState(spells, 0, 0, typeKey("", ""));

    assert.equal(state.score, 0);
    assert.equal(state.bsScore, 1);
    assert.equal(state.cfScore, 1.4);
    assert.equal(state.efScore, 1.3);
    assert.equal(state.minOnscreens, 0);
    assert.equal(state.toKeep, "");
    assert.equal(state.row, 0);
    assert.equal(state.gfthofs, 0);
  });

  it("zeroes a held buff's score and charges one onscreen for keeping its cookie", () => {
    const held = new RouteBoundState(spells, 0, 0, typeKey("cfef", "cfef"));
    assert.equal(held.cfScore, 0);
    assert.equal(held.efScore, 0);
    assert.equal(held.minOnscreens, 2);
    assert.equal(held.toKeep, "cfef");

    const heldNotKept = new RouteBoundState(spells, 0, 0, typeKey("cfef", ""));
    assert.equal(heldNotKept.minOnscreens, 0, "holding a buff does not force its cookie to stay");

    const keptNotHeld = new RouteBoundState(spells, 0, 0, typeKey("", "cfef"));
    assert.equal(keptNotHeld.minOnscreens, 0, "a cookie cannot be kept before its buff is earned");
  });

  it("counts a success window that shrinks by 0.15 per mandatory onscreen", () => {
    const at = (type: PossibleEvaluations, roll: number): boolean =>
      new RouteBoundState(spells, 0, 0, type).possibleToSucceed(roll);

    const none = typeKey("", "");
    const one = typeKey("cf", "cf");
    const two = typeKey("cfef", "cfef");

    assert.equal(at(none, 0.98), true);
    assert.equal(at(none, 0.99), false);
    assert.equal(at(one, 0.83), true);
    assert.equal(at(one, 0.84), false);
    assert.equal(at(two, 0.68), true);
    assert.equal(at(two, 0.69), false);
  });

  it("purifies bs and cf behind the success window but never ef", () => {
    const raw = [
      BS(0.99),
      BS(0.98),
      CF(0.5),
      EF(0.99),
      createSpell({ dfBs: true, bs: true, gfdRs: 0.5 }),
      createSpell({ bs: true, cf: true, gfdRs: 0.9 }),
    ];
    const state = new RouteBoundState(raw, 0, 0, typeKey("", ""));
    const purified = state.spells;

    assert.equal(purified[0]!.bs, false, "0.99 cannot succeed");
    assert.equal(purified[1]!.bs, true);
    assert.equal(purified[2]!.cf, true);
    assert.equal(purified[3]!.ef, true, "ef comes from a backfire and is not roll-gated");
    assert.equal(purified[4]!.dfBs, true, "dfBs follows bs, even though nothing reads it yet");
    assert.equal(purified[5]!.bs, true);
    assert.equal(purified[5]!.cf, true);
  });

  it("drops a buff from the purified queue when its score is already spent", () => {
    // The middle row only carries ef, so a spent score hides it from the
    // affected column but leaves the other buff exactly as the queue had it.
    const raw = [CF(0.5), EF(0.5), createSpell({ cf: true, ef: true, gfdRs: 0.5 })];
    const noCf = new RouteBoundState(raw, 0, 0, typeKey("cf", ""));
    assert.deepEqual(
      noCf.spells.map((spell) => spell.cf),
      [false, false, false],
    );
    assert.deepEqual(
      noCf.spells.map((spell) => spell.ef),
      [false, true, true],
    );

    const noEf = new RouteBoundState(raw, 0, 0, typeKey("ef", ""));
    assert.deepEqual(
      noEf.spells.map((spell) => spell.ef),
      [false, false, false],
    );
    assert.deepEqual(
      noEf.spells.map((spell) => spell.cf),
      [true, false, true],
    );
  });

  it("keeps the raw queue when constructed without a type, for duplicate() to build on", () => {
    const state = new RouteBoundState(spells, 0, 0);
    assert.equal(
      state.spells,
      spells,
      "the no-type path is the pass-through duplicate() relies on",
    );
    assert.equal(state.toKeep, "");
    assert.equal(state.minOnscreens, 0);
  });

  it("duplicates every field without sharing the scalars", () => {
    const source = new RouteBoundState(spells, 1, 2, typeKey("cf", "cf"));
    source.score = 5;

    const copy = source.duplicate();

    assert.notEqual(copy, source);
    assert.equal(copy.spells, source.spells, "the purified queue is immutable and may be shared");
    assert.equal(copy.row, 1);
    assert.equal(copy.gfthofs, 2);
    assert.equal(copy.score, 5);
    assert.equal(copy.bsScore, 1);
    assert.equal(copy.cfScore, 0);
    assert.equal(copy.efScore, 1.3);
    assert.equal(copy.minOnscreens, 1);
    assert.equal(copy.toKeep, "cf");

    copy.score = 9;
    copy.minOnscreens = 4;
    assert.equal(source.score, 5, "mutating the copy must not touch the source");
    assert.equal(source.minOnscreens, 1);
  });

  it("tracks its position independently of the shared queue", () => {
    const state = new RouteBoundState(spells, 0, 0, typeKey("", ""));

    assert.equal(state.ended(), false);
    assert.equal(state.peek(), state.spells[0]);
    assert.equal(state.increment(), state.spells[0]);
    assert.equal(state.row, 1);
    assert.equal(state.increment(), state.spells[1]);
    assert.equal(state.increment(), state.spells[2]);
    assert.equal(state.ended(), true);
    assert.equal(state.peek(), undefined);
  });
});

/* -------------------------------------------------------------------------- *
 * SimpleActions: action contracts
 * -------------------------------------------------------------------------- */

describe("SimpleActions: action contracts", () => {
  const actionByName = new Map<string, SimpleAction>(
    SimpleActions.map((action) => [action.name, action]),
  );

  const action = (name: string): SimpleAction => {
    const found = actionByName.get(name);
    assert.ok(found !== undefined, `unknown action "${name}"`);

    return found;
  };

  /** Snapshot of every field an action may write, for "able() is pure" checks. */
  const snap = (state: RouteBoundState) => ({
    score: state.score,
    row: state.row,
    gfthofs: state.gfthofs,
    minOnscreens: state.minOnscreens,
    cfScore: state.cfScore,
    efScore: state.efScore,
    bsScore: state.bsScore,
    toKeep: state.toKeep,
    spells: state.spells,
  });

  /** Invoke `name` on a copy, after asserting it claims to be able. */
  function run(state: RouteBoundState, name: string): RouteBoundState {
    const chosen = action(name);
    assert.equal(chosen.able(state), true, `"${name}" reports itself unable`);
    const copy = state.duplicate();
    chosen.invoke(copy);

    return copy;
  }

  const start = (roll: number, flags: Partial<Spell>, type: PossibleEvaluations): RouteBoundState =>
    new RouteBoundState([createSpell({ ...flags, gfdRs: roll })], 0, 0, type);

  it("exposes exactly the documented action names", () => {
    assert.deepEqual(
      SimpleActions.map((candidate) => candidate.name),
      [
        "fthof-bs",
        "fthof-cf",
        "fthof-ef",
        "g!fthof",
        "resolve-bs",
        "resolve-cf",
        "resolve-ef",
        "skip",
      ],
    );
  });

  it("never mutates the state handed to able()", () => {
    const states = [
      start(0.2, {}, typeKey("", "")),
      start(0.2, { bs: true }, typeKey("cf", "cf")),
      start(0.9, { cf: true, ef: true }, typeKey("cf", "cfef")),
      new RouteBoundState([G(0.2), BS(0.2)], 1, 1, typeKey("", "ef")),
    ];

    for (const state of states) {
      for (const candidate of SimpleActions) {
        const before = snap(state);
        candidate.able(state);
        assert.deepEqual(snap(state), before, `"${candidate.name}" must not mutate in able()`);
      }
    }
  });

  it("[fthof-bs] pays bs and consumes the row", () => {
    const state = start(0.5, { bs: true }, typeKey("", ""));
    const after = run(state, "fthof-bs");

    assert.equal(after.score, 1);
    assert.equal(after.row, 1, "a plain cast consumes the row it was cast on");
    assert.equal(after.gfthofs, 0);
    assert.equal(after.minOnscreens, state.minOnscreens, "bs is not a kept cookie");
    assert.equal(action("fthof-bs").able(start(0.99, { bs: true }, typeKey("", ""))), false);
    assert.equal(action("fthof-bs").able(start(0.5, { cf: true }, typeKey("", ""))), false);
  });

  it("[fthof-cf] pays cf once and forces its cookie to stay when asked to keep it", () => {
    const plain = run(start(0.5, { cf: true }, typeKey("", "")), "fthof-cf");
    assert.equal(plain.score, 1.4);
    assert.equal(plain.cfScore, 0, "cf is one-shot");
    assert.equal(plain.row, 1);
    assert.equal(plain.minOnscreens, 0, "toKeep did not ask for the cookie");

    const kept = run(start(0.5, { cf: true }, typeKey("", "cf")), "fthof-cf");
    assert.equal(kept.minOnscreens, 1, "an onscreen cookie was committed to");

    const spent = start(0.5, { cf: true }, typeKey("", ""));
    spent.cfScore = 0;
    assert.equal(action("fthof-cf").able(spent), false, "no score left to pay with");
  });

  it("[fthof-ef] pays ef on any roll, because ef is the backfire outcome", () => {
    const calm = run(start(0.2, { ef: true }, typeKey("", "ef")), "fthof-ef");
    assert.equal(calm.score, 1.3);
    assert.equal(calm.efScore, 0);
    assert.equal(calm.minOnscreens, 1);
    assert.equal(calm.row, 1);

    const backfire = run(start(0.99, { ef: true }, typeKey("", "")), "fthof-ef");
    assert.equal(backfire.score, 1.3, "a roll a plain cast could never turn into a success");

    const spent = start(0.99, { ef: true }, typeKey("", ""));
    spent.efScore = 0;
    assert.equal(action("fthof-ef").able(spent), false);
  });

  it("[g!fthof] only queues a resolve and consumes the row", () => {
    const after = run(start(0.2, {}, typeKey("", "")), "g!fthof");
    assert.equal(after.score, 0);
    assert.equal(after.gfthofs, 1);
    assert.equal(after.row, 1);

    const g = action("g!fthof");
    assert.equal(g.able(start(0.2, {}, typeKey("", ""))), true);
    assert.equal(g.able(start(GFD_FTHOF_MIN, {}, typeKey("", ""))), true);
    assert.equal(g.able(start(GFD_FTHOF_MIN - 0.001, {}, typeKey("", ""))), false);
    assert.equal(g.able(start(GFD_FTHOF_MAX, {}, typeKey("", ""))), false, "half-open window");
  });

  it("[resolve-bs] pays bs without consuming the row, and only inside the g! success window", () => {
    const state = new RouteBoundState([G(0.2), BS(0.2)], 1, 1, typeKey("", ""));
    const after = run(state, "resolve-bs");

    assert.equal(after.score, 1);
    assert.equal(after.gfthofs, 0, "one resolve settles one g!fthof");
    assert.equal(after.row, 1, "the row survives the resolve");
    assert.equal(after.minOnscreens, 0, "bs is not a kept cookie");

    const resolve = action("resolve-bs");
    assert.equal(
      resolve.able(new RouteBoundState([BS(0.2)], 0, 0, typeKey("", ""))),
      false,
      "no pending",
    );
    assert.equal(resolve.able(new RouteBoundState([BS(0.4)], 0, 1, typeKey("", ""))), true);
    assert.equal(resolve.able(new RouteBoundState([BS(0.5)], 0, 1, typeKey("", ""))), false);
    assert.equal(resolve.able(new RouteBoundState([CF(0.2)], 0, 1, typeKey("", ""))), false);
  });

  it("[resolve-cf] pays cf once, keeps its cookie when asked, and clears the pending resolve", () => {
    const after = run(
      new RouteBoundState([G(0.2), CF(0.2)], 1, 1, typeKey("", "cf")),
      "resolve-cf",
    );
    assert.equal(after.score, 1.4);
    assert.equal(after.cfScore, 0);
    assert.equal(after.gfthofs, 0);
    assert.equal(after.row, 1);
    assert.equal(after.minOnscreens, 1);

    const spent = new RouteBoundState([G(0.2), CF(0.2)], 1, 1, typeKey("", ""));
    spent.cfScore = 0;
    assert.equal(action("resolve-cf").able(spent), false, "no score left to pay with");
    assert.equal(
      action("resolve-cf").able(new RouteBoundState([G(0.2), CF(0.6)], 1, 1, typeKey("", ""))),
      false,
      "outside the capped g! success window",
    );
  });

  it("[resolve-ef] pays ef on any roll and clears the pending resolve", () => {
    const after = run(
      new RouteBoundState([G(0.2), EF(0.99)], 1, 2, typeKey("", "ef")),
      "resolve-ef",
    );
    assert.equal(after.score, 1.3);
    assert.equal(after.efScore, 0);
    assert.equal(after.gfthofs, 1, "only one of the two pending resolves is spent");
    assert.equal(after.row, 1);
    assert.equal(after.minOnscreens, 1);

    const noPending = new RouteBoundState([EF(0.5)], 0, 0, typeKey("", ""));
    assert.equal(action("resolve-ef").able(noPending), false);
  });

  it("[skip] only advances the row", () => {
    const state = new RouteBoundState([G(0.2), BS(0.2)], 0, 1, typeKey("cf", "cf"));
    const after = run(state, "skip");

    assert.equal(after.row, 1);
    assert.equal(after.score, 0);
    assert.equal(after.gfthofs, 1, "skipping leaves the queue alone");
    assert.equal(after.minOnscreens, state.minOnscreens);

    assert.equal(action("skip").able(new RouteBoundState([], 0, 0, typeKey("", ""))), false);
  });
});

/* -------------------------------------------------------------------------- *
 * route.ts integration
 * -------------------------------------------------------------------------- */

describe("route.ts: the bound table as the search's ceiling", () => {
  it("installs routeBounds(spells) as the state's value evaluation list", () => {
    const spells = [G(0.2), BS(0.2), CF(0.5)];
    const state = new RouteState(null, spells, 200, 0, 200, 0);

    assert.equal(
      state.initializeValueEvaluationList(),
      state,
      "it chains like the old initializer",
    );
    assert.deepEqual(state.valueEvaluationList, routeBounds(spells));
  });

  it("looks up the row for the buffs the state already holds", () => {
    const spells = [BS(0.5), CF(0.5)];
    const table = routeBounds(spells);
    const state = new RouteState(null, spells, 200, 0, 200, 0).initializeValueEvaluationList();

    assert.equal(
      state.currentMaxValue(),
      state.currentValue() + bound(table, 0, 0, typeKey("", "")),
      "a fresh route uses the no-buffs row",
    );

    state.addBuff("cf");
    assert.equal(
      state.currentMaxValue(),
      state.currentValue() + bound(table, 0, 0, typeKey("cf", "")),
    );

    state.addBuff("ef");
    assert.equal(
      state.currentMaxValue(),
      state.currentValue() + bound(table, 0, 0, typeKey("cfef", "")),
      "cf and ef are ordered cf-then-ef when the key is built",
    );
  });

  it("counts only queued FTHOF resolves when it picks the pending slot", () => {
    const spells = [G(0.2), BS(0.2)];
    const table = routeBounds(spells);
    const state = new RouteState(null, spells, 200, 1, 200, 0).initializeValueEvaluationList();

    state.addResolve(0, 0, SpellIndices.RA);
    assert.equal(
      state.currentMaxValue(),
      state.currentValue() + bound(table, 1, 0, typeKey("", "")),
      "a queued ra occupies no g!fthof slot",
    );

    state.addResolve(0, 0, SpellIndices.FTHOF);
    assert.equal(
      state.currentMaxValue(),
      state.currentValue() + bound(table, 1, 1, typeKey("", "")),
    );
  });

  it("reports NaN when the table cannot answer", () => {
    const empty = new RouteState(null, [], 200, 0, 200, 0).initializeValueEvaluationList();
    assert.ok(Number.isNaN(empty.currentMaxValue()), "an empty queue has no row 0");

    const past = new RouteState(null, [BS(0.5)], 200, 1, 200, 0).initializeValueEvaluationList();
    assert.ok(Number.isNaN(past.currentMaxValue()), "the queue is exhausted");

    const tooMany = new RouteState(null, [BS(0.5)], 200, 0, 200, 0).initializeValueEvaluationList();
    tooMany.addResolve(0, 0, SpellIndices.FTHOF);
    assert.ok(
      Number.isNaN(tooMany.currentMaxValue()),
      "no g!fthof source before row 0, so there is no pending slot 1 to read",
    );
  });

  it("scores the straightforward walk when no g!fthof payment can be doubled", () => {
    // Four rows, the only g!fthof sources are the two the effects sit on, so a
    // g!fthof cast has to give up more than the queued resolve can pay back and
    // the best route is the plain walk: 1 + 1.4 + 1.3 + 1.
    const spells = [BS(0.2), CF(0.3), EF(0.4), BS(0.6)];
    assert.equal(bound(routeBounds(spells), 0, 0, typeKey("", "")), 4.7);
  });
});
