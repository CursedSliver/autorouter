/**
 * Contract tests for the route core (`src/app/route/route.ts`) and the
 * precomputed tables it reads (`src/app/route/tables.ts`).
 *
 * The route core is covered structurally rather than by worked-score examples:
 * the score function, the `RouteState` copy contract, action legality, and how a
 * GFD that cannot reach its spell cancels instead of spending magic. The table
 * sections check the precomputed data against a fresh computation of the same
 * thing (and, for `TransmuteTable`, against `offsetGraph.js`'s encoding).
 *
 * `fthof` is split by outcome - `fthof-cf`, `fthof-bs`, `fthof-ef` - because a
 * cast's result depends on its flag *and* on the golden/wrath cookies left on
 * screen (`onscreens`). Each cookie raises the backfire chance by 15%, so a cast
 * that must land clicks cookies away (keeping the most the roll survives) while
 * one that must backfire leans on them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import route, { Actions, RouteState, SpellIndices } from "../route/route";
import type { Action, Spell } from "../route/route";
import Spells from "../route/spelldata";
import { RangedTransmuteGuides, TransmuteTable, gfdOnlyRanges } from "../route/tables";
import { createSpell } from "../../lib/spell";
import { auraMatrix, buildTransmutationTable } from "./offsetGraph";

/** Spell-table shorthand: flags in the name, gfd roll as the argument. */
const B = (gfdRs: number): Partial<Spell> => ({ bs: true, gfdRs });

/**
 * The restrictions every state in this file runs under unless a test says
 * otherwise: SI and RB both slotted. Every cost (x0.89) and backfire (x1.11)
 * constant below is written for that profile, so a state built the plain way
 * would quietly run at full price and the base backfire chance instead.
 */
const DEFAULT_RESTRICTIONS = { siAllowed: true, rbAllowed: true } as const;

/** `new RouteState(...)` with the default restrictions already applied. */
function routeState(
  parent: RouteState | null,
  spells: Spell[],
  currentMagic: number,
  spellIndex: number,
  metamax: number,
  refills: 0 | 1 | 2,
): RouteState {
  return new RouteState(parent, spells, currentMagic, spellIndex, metamax, refills).setRestrictions(
    DEFAULT_RESTRICTIONS,
  );
}

const actionByName = new Map<string, Action>(Actions.map((action) => [action.name, action]));

interface Snapshot {
  value: number;
  magic: number;
  bs: number;
  cf: boolean;
  ef: boolean;
  clot: boolean;
  onscreens: number;
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
    onscreens: state.onscreens,
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

describe("route(): state and action contracts", () => {
  it("scores bs + 1.4 cf + 1.3 ef - 0.1 clot", () => {
    const state = routeState(null, [], 0, 0, 200, 0);
    assert.equal(state.currentValue(), 0);

    state.addBuff("clot");
    assert.ok(Math.abs(state.currentValue() - -0.1) < 1e-9);

    state.addBuff("bs");
    state.addBuff("bs");
    state.addBuff("cf");
    state.addBuff("ef");
    assert.ok(Math.abs(state.currentValue() - 4.6) < 1e-9, "2 bs + cf + ef - clot");
  });

  it("is deterministic: the same input yields the same route", () => {
    const table = () => [B(0.5), B(0.5), B(0.5)].map((spell) => createSpell(spell));
    const resources = {
      goal: 1,
      metamax: 200,
      currentMagic: 200,
      startingRefills: 0,
      restrictions: DEFAULT_RESTRICTIONS,
    } as const;
    // `route()` logs its step counter; keep the test output readable.
    const log = console.log;
    console.log = () => {};
    try {
      const first = route({ spells: table(), ...resources });
      const second = route({ spells: table(), ...resources });
      assert.deepEqual(snap(second), snap(first));
      assert.deepEqual(routeNames(second), routeNames(first));
    } finally {
      console.log = log;
    }
  });

  it("cancels a GFD that cannot reach its spell instead of spending magic", () => {
    // At (magic 200, metamax 200, roll 0.5) the pool holds every spell, so the
    // roll's chunk picks one slot. Whatever that slot is, the other seven g!
    // variants have to report cancellation: no magic, no queue movement.
    const state = routeState(null, [createSpell(B(0.5))], 200, 0, 200, 0);
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

    // A full pool is the one case where the tables' reversed lookup and the
    // spell list agree: roll 0.5 is chunk 4 of 8, which is `hc` (cbg 0 ...
    // di 7). The other seven variants have to cancel rather than spend magic.
    assert.deepEqual(matched, ["g!hc"]);
    assert.equal(cancelled, 7);
    assert.deepEqual(snap(state), before, "probing with duplicate() must not mutate the state");
  });

  it("keeps refills legal only while charges remain and magic is below the cap", () => {
    const refill = actionByName.get("refill");
    assert.ok(refill !== undefined);

    const atCap = routeState(null, [], 30, 0, 30, 2);
    assert.equal(refill.able(atCap), false, "a refill at metamax spends a charge for nothing");

    const empty = routeState(null, [], 0, 0, 30, 2);
    assert.equal(refill.able(empty), true);
    assert.ok(empty.act(refill));
    assert.equal(empty.currentMagic, 30, "a refill clamps to metamax");
    assert.equal(empty.refills, 1);

    const spent = routeState(null, [], 0, 0, 30, 0);
    assert.equal(refill.able(spent), false, "no charges left");
  });

  it("duplicates every field the search relies on, without sharing mutable data", () => {
    const source = routeState(null, [], 100, 2, 200, 1);
    source.addBuff("bs");
    source.addBuff("cf");
    source.addBuff("ef");
    source.addBuff("clot");
    source.addBuff("di");
    source.onscreens = 4;
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
    assert.equal(copy.onscreens, 4, "the on-screen cookie count carries into descendants");

    copy.addBuff("diB");
    assert.equal(copy.di, false);
    assert.equal(copy.diB, true, "di and diB are mutually exclusive");
    assert.equal(source.di, true, "mutating a copy must not flip the source's buff");
    copy.onscreens = 0;
    assert.equal(source.onscreens, 4, "mutating a copy must not touch the source's cookies");
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

/* -------------------------------------------------------------------------- *
 * Tables: `RangedTransmuteGuides`
 *
 * `RangedTransmuteGuides[range][spell][currentMagic][maxMagic]` is derived data:
 * it must say exactly what `TransmuteTable` says, at the low end of the roll
 * range. The byte is a bitmask `0000<none><si><rb><sirb>` - bit 3 = the x1
 * pool, bit 2 = x0.9, bit 1 = x0.99, bit 0 = x0.89 - matching the multiplier
 * list `[1, 0.9, 0.99, 0.89]` read from the highest bit down.
 *
 * The tests below recompute every byte from `TransmuteTable` with a separate
 * implementation of the slot-selection rule, and pin the bit order with the
 * pool-nesting invariant. Bits above the four pool bits stay zero.
 * -------------------------------------------------------------------------- */

type SpellId = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** `tables.ts` MAX_SIZE: the width of both `TransmuteTable` dimensions. */
const TABLE_SIZE = 384;
/** `tables.ts` TRUE_METAMAX: the guide only covers max magic below this cap. */
const GUIDE_CAP = 256;

/** The pool each guide bit stands for, bit 0 first: x0.89, x0.99, x0.9, x1. */
const GUIDE_BITS = ["sirb", "rb", "si", "none"] as const;

/** Low edge of every roll range, plus the epsilon nudge the table itself applies. */
const RANGE_ROLLS = gfdOnlyRanges.map((boundary) => boundary + 4 * Number.EPSILON);

function popCount8(pool: number): number {
  let bits = 0;
  for (let value = pool; value !== 0; value >>>= 1) {
    bits += value & 1;
  }
  return bits;
}

/**
 * The spell a cast reaches at roll `roll` when the GFD pool is `pool` (bit `m`
 * of `pool` is spell index `m`), or `null` when the roll reaches no slot.
 *
 * Mirrors the rule the tables encode: the roll selects slot
 * `floor(roll * popCount)` counting up from bit 0, and the transmute target is
 * that slot's own bit, so earlier spells own the chunks closer to 0.
 */
function transmuteTarget(roll: number, pool: number): SpellId | null {
  const count = popCount8(pool);
  if (count === 0) {
    return null;
  }
  const slot = Math.floor(roll * count);
  let seen = 0;
  for (let bit = 0; bit < 8; bit++) {
    if (((pool >>> bit) & 1) === 0) {
      continue;
    }
    if (seen === slot) {
      return bit as SpellId;
    }
    seen += 1;
  }
  return null; // the roll reaches past the last set bit: nothing transmutes
}

/** `POOL_TARGETS[range][pool]` is the spell `RANGE_ROLLS[range]` reaches, or -1. */
const POOL_TARGETS: Int8Array[] = RANGE_ROLLS.map((roll) => {
  const targets = new Int8Array(256).fill(-1);
  for (let pool = 0; pool < 256; pool++) {
    const target = transmuteTarget(roll, pool);
    if (target !== null) {
      targets[pool] = target;
    }
  }
  return targets;
});

/** Human-readable form of one guide byte, for assertion messages. */
function readMask(mask: number): string {
  const pools = [3, 2, 1, 0]
    .filter((bit) => ((mask >>> bit) & 1) === 1)
    .map((bit) => GUIDE_BITS[bit]);
  return `${mask.toString(2).padStart(8, "0")} (${pools.length > 0 ? pools.join("+") : "no pool"})`;
}

describe("tables: RangedTransmuteGuides vs TransmuteTable", () => {
  it("has one dense byte per (roll range, spell) for every current magic", () => {
    assert.equal(TransmuteTable.length, TABLE_SIZE);
    for (let cur = 0; cur < TABLE_SIZE; cur++) {
      assert.equal(TransmuteTable[cur]!.length, TABLE_SIZE, `TransmuteTable[${cur}] width`);
    }

    for (let range = 0; range < RANGE_ROLLS.length; range++) {
      const perSpell = RangedTransmuteGuides[range];
      assert.ok(perSpell !== undefined, `RangedTransmuteGuides[${range}] is missing`);
      for (let id = 0; id < 8; id++) {
        const rows: Uint8Array[] | undefined = perSpell[id as SpellId];
        assert.ok(rows !== undefined, `RangedTransmuteGuides[${range}][${id}] is missing`);
        assert.equal(rows.length, TABLE_SIZE, `RangedTransmuteGuides[${range}][${id}] rows`);
        for (let cur = 0; cur < TABLE_SIZE; cur++) {
          const row: Uint8Array | undefined = rows[cur];
          assert.ok(row !== undefined, `RangedTransmuteGuides[${range}][${id}][${cur}] is missing`);
          assert.equal(row.length, GUIDE_CAP, `RangedTransmuteGuides[${range}][${id}][${cur}] cap`);
        }
      }
    }
  });

  it("matches TransmuteTable at every (range, current magic, max magic)", () => {
    const expected = new Uint8Array(8).fill(0);
    for (let range = 0; range < RANGE_ROLLS.length; range++) {
      const targets = POOL_TARGETS[range]!;
      const perSpell = RangedTransmuteGuides[range]!;
      for (let cur = 0; cur < TABLE_SIZE; cur++) {
        const rowForSpell: Uint8Array[] = [];
        for (let id = 0; id < 8; id++) {
          rowForSpell.push(perSpell[id as SpellId]![cur]!);
        }
        const column = TransmuteTable[cur]!;
        for (let max = 0; max < GUIDE_CAP; max++) {
          const entry = column[max]!;
          expected.fill(0);
          for (let bit = 0; bit < 4; bit++) {
            const target = targets[(entry >>> (bit * 8)) & 0xff]!;
            if (target >= 0) {
              expected[target] = expected[target]! | (1 << bit);
            }
          }
          for (let id = 0; id < 8; id++) {
            const actual = rowForSpell[id]![max]!;
            if (actual !== expected[id]) {
              assert.fail(
                `RangedTransmuteGuides[${range}][${id}][${cur}][${max}] is ${readMask(actual)}, ` +
                  `TransmuteTable requires ${readMask(expected[id]!)}`,
              );
            }
          }
        }
      }
    }
  });

  it("consults pools nested the way [1, 0.9, 0.99, 0.89] nest", () => {
    // A smaller multiplier relaxes both terms of the cost threshold, so its pool
    // is a superset. Pop counts therefore fall from the x0.89 pool (bit 0) to the
    // x1 pool (bit 3): x0.89 >= x0.9 >= x0.99 >= x1. Any swap of the pools behind
    // the four bits - including the near-miss x0.9 / x0.99 pair - shows up here.
    for (let cur = 0; cur < TABLE_SIZE; cur++) {
      for (let max = 0; max < GUIDE_CAP; max++) {
        const entry = TransmuteTable[cur]![max]!;
        const sirb = popCount8(entry & 0xff);
        const rb = popCount8((entry >>> 8) & 0xff);
        const si = popCount8((entry >>> 16) & 0xff);
        const none = popCount8((entry >>> 24) & 0xff);
        if (sirb >= si && si >= rb && rb >= none) {
          continue;
        }
        assert.fail(
          `TransmuteTable[${cur}][${max}] pools are not nested: ` +
            `sirb=${sirb} si=${si} rb=${rb} none=${none}`,
        );
      }
    }
  });

  it("flags all four pools on one spell when every pool holds every spell", () => {
    // At the largest (current magic, max magic) every spell clears every cost
    // threshold, so each TransmuteTable byte is 0xff and the four pools reach the
    // same slot: floor(roll * 8) steps down from the top of the full pool.
    const cur = TABLE_SIZE - 1;
    const max = GUIDE_CAP - 1;
    assert.equal(TransmuteTable[cur]![max], 0xffffffff, "expected a full pool at every multiplier");
    for (let range = 0; range < RANGE_ROLLS.length; range++) {
      const slot = Math.floor(RANGE_ROLLS[range]! * 8);
      for (let id = 0; id < 8; id++) {
        const actual = RangedTransmuteGuides[range]![id as SpellId]![cur]![max]!;
        const want = id === slot ? 0b1111 : 0;
        assert.equal(actual, want, `RangedTransmuteGuides[${range}][${id}][${cur}][${max}]`);
      }
    }
  });
});

/* -------------------------------------------------------------------------- *
 * Tables: `TransmuteTable` vs `offsetGraph.js`
 *
 * `offsetGraph.js` draws the transmutation table that was verified against the
 * live game, in its own encoding: `allGFDConfigs` indexes every distinct GFD
 * pool, and `dataPoints[currentMagic][maxMagic]` packs the index of the pool
 * each multiplier reaches as four base-100 digits, `{1, 0.9, 0.99, 0.89}` from
 * the least significant digit up.
 *
 * `TransmuteTable[currentMagic][maxMagic]` holds the same four pools as bytes:
 * bit `i` of a pool byte means "spell index `i` is in the pool", and the bytes
 * run highest multiplier first. Converting one encoding into the other and
 * comparing every cell pins which spell owns which bit, which multiplier owns
 * which byte, and where every pool boundary sits.
 * -------------------------------------------------------------------------- */

/** The spell tags `offsetGraph.js` uses, in catalog index order. */
const GFD_TAGS = ["cbg", "fthof", "st", "se", "hc", "scp", "ra", "di"] as const;

/** Spell data by index, the order `TransmuteTable` assigns pool bits in. */
const SPELLS_BY_INDEX = Object.values(Spells).sort((a, b) => a.index - b.index);

/** Spell tag -> the bit `TransmuteTable` gives it inside a pool byte. */
const TAG_BIT: Record<string, number> = {};
for (const spell of SPELLS_BY_INDEX) {
  TAG_BIT[GFD_TAGS[spell.index]!] = 1 << spell.index;
}

/** Multiplier labels, highest multiplier first, matching both encodings. */
const MULTIPLIER_LABELS = ["x1 (none)", "x0.9 (si)", "x0.99 (rb)", "x0.89 (sirb)"] as const;

/**
 * The raw pool lookup `offsetGraph.js` reads from the app core, rebuilt from
 * `spelldata.ts`: the tags of every spell a GFD can cast at this magic pair,
 * with the multiplier's discount applied to the cast and the GFD surcharge on
 * top of it.
 */
function getPossibleGFDs(currentMagic: number, maxMagic: number, mult: number): string[] {
  const gfd = Math.floor(mult * (3 + 0.05 * maxMagic));
  const pool: string[] = [];
  for (const spell of SPELLS_BY_INDEX) {
    const castCost = Math.floor(mult * (spell.baseCost + spell.portionCost * maxMagic)) / 2;
    if (currentMagic >= castCost + gfd) {
      pool.push(GFD_TAGS[spell.index]!);
    }
  }
  return pool;
}

/** The raw table over exactly the grid `TransmuteTable` covers. */
const RAW_TABLE = buildTransmutationTable({
  getPossibleGFDs,
  magicAbsMax: TABLE_SIZE - 1,
  minMax: 0,
  maxSample: TABLE_SIZE - 1,
});

/** The four pool indices packed into one `dataPoints` cell, lowest digit first. */
function packedDigits(packed: number): number[] {
  return [
    packed % 100,
    Math.floor(packed / 100) % 100,
    Math.floor(packed / 10000) % 100,
    Math.floor(packed / 1000000) % 100,
  ];
}

describe("tables: TransmuteTable vs offsetGraph's raw table", () => {
  it("is built from the multipliers tables.ts hardcodes", () => {
    // The graph derives 0.9/0.99/0.89 from the aura checkboxes; those derived
    // doubles have to be the literals the tables use, or the pools could diverge.
    assert.deepEqual(auraMatrix(), [1, 0.9, 0.99, 0.89]);
  });

  it("indexes every pool it reaches, within the base-100 packing", () => {
    const { allGFDConfigs, dataPoints } = RAW_TABLE;
    assert.deepEqual(allGFDConfigs[0], [], "index 0 is the empty pool");
    assert.deepEqual(allGFDConfigs[1], [...GFD_TAGS], "index 1 is the full pool");
    assert.ok(
      allGFDConfigs.length < 100,
      `the base-100 packing cannot hold ${allGFDConfigs.length} pools`,
    );
    assert.equal(
      new Set(allGFDConfigs.map((config) => config.join("+"))).size,
      allGFDConfigs.length,
      "every pool is indexed exactly once",
    );
    for (const config of allGFDConfigs) {
      for (const tag of config) {
        assert.ok(tag in TAG_BIT, `a pool holds unknown spell tag "${tag}"`);
      }
    }

    assert.equal(dataPoints.length, TABLE_SIZE, "one data row per current magic");
    for (let cur = 0; cur < TABLE_SIZE; cur++) {
      const row = dataPoints[cur]!;
      assert.equal(row.length, TABLE_SIZE, `dataPoints[${cur}] covers max magic`);
      for (let max = 0; max < TABLE_SIZE; max++) {
        for (const index of packedDigits(row[max]!)) {
          if (index < 0 || index >= allGFDConfigs.length) {
            assert.fail(`dataPoints[${cur}][${max}] names pool ${index}, which is not in the list`);
          }
        }
      }
    }
  });

  it("matches every TransmuteTable cell after converting the encoding", () => {
    const { allGFDConfigs, dataPoints } = RAW_TABLE;
    const poolMasks = allGFDConfigs.map((config) => {
      let mask = 0;
      for (const tag of config) {
        mask |= TAG_BIT[tag]!;
      }
      return mask;
    });

    for (let cur = 0; cur < TABLE_SIZE; cur++) {
      const row = dataPoints[cur]!;
      const tableRow = TransmuteTable[cur]!;
      for (let max = 0; max < TABLE_SIZE; max++) {
        const digits = packedDigits(row[max]!);
        const actual = tableRow[max]!;
        for (let mult = 0; mult < 4; mult++) {
          const index = digits[mult]!;
          const label = MULTIPLIER_LABELS[mult]!;
          const expected = poolMasks[index];
          if (expected === undefined) {
            assert.fail(`dataPoints[${cur}][${max}] names pool ${index} for ${label}`);
          }
          const byte = (actual >>> (8 * (3 - mult))) & 0xff;
          if (byte !== expected) {
            const config = allGFDConfigs[index];
            assert.fail(
              `TransmuteTable[${cur}][${max}] ${label} is ${byte.toString(2).padStart(8, "0")}, ` +
                `offsetGraph says ${expected.toString(2).padStart(8, "0")} ` +
                `(pool ${index}: ${config === undefined || config.length === 0 ? "(empty)" : config.join("+")})`,
            );
          }
        }
      }
    }
  });
});

/* -------------------------------------------------------------------------- *
 * route(): action mechanics
 *
 * The model these tests pin down:
 *
 * - A normal cast costs `floor(0.89 * (base + portion * currentMagic))` - for a
 *   normal cast the max magic *is* the current magic - and is refused outright
 *   when the magic is not there.
 * - A gfd cast costs `floor(0.89 * (3 + 0.05 * maxMagic))`, consumes the row it
 *   was cast on and queues exactly one resolve. It searches max magic in
 *   `[currentMagic, metamax]` and takes the first value whose castable pool
 *   selects the requested spell; nothing selected means cancellation.
 * - A pool of `n` castable spells splits `[0, 1)` into `n` equal chunks, and
 *   chunk `c` - the roll's `floor(roll * n)` - belongs to the c-th spell of the
 *   list, so earlier spells own the chunks closer to 0.
 * - `fthof` is split by outcome (`fthof-cf`/`-bs`/`-ef`). `cf` and `bs` need the
 *   cast to land, `ef` needs it to backfire; every cast spawns one cookie on
 *   screen, and each cookie raises the backfire chance by 15%. A cast that must
 *   land clicks the excess cookies away, keeping the most the roll survives and
 *   never going negative; a cast that must backfire leaves them alone.
 * - `resolve` settles the oldest queued gfd without consuming a row, casting at
 *   the chain cost stored when that gfd was cast (it is never recomputed). `ra`
 *   refunds its gfd cost, `se` refunds only when the row it resolves on does not
 *   backfire, and any spell refunds when the chain cost cannot be paid. A
 *   queued `g!fthof` is settled by `resolve-fthof-cf`/`-bs`/`-ef` instead.
 * - Magic never goes negative and never passes the metamax; a resolve refund is
 *   the one way above the cap, and only after a refill clamped it.
 * - Backfires: base chance `0.15 * 1.11`, times 0.1 under `di` and times 5 under
 *   `diB`, floored at 50% for a gfd resolve. A row backfires when its roll is
 *   above `1 - chance`, and a resolve checks the row it lands on.
 * -------------------------------------------------------------------------- */

/** Spell data, by the tag `offsetGraph.js` uses. */
const SPELL_BY_TAG: Record<string, { baseCost: number; portionCost: number; index: number }> = {};
for (const spell of SPELLS_BY_INDEX) {
  SPELL_BY_TAG[GFD_TAGS[spell.index]!] = spell;
}

/** What a normal cast of this spell costs at this magic. */
function castCostOf(tag: string, currentMagic: number): number {
  const spell = SPELL_BY_TAG[tag]!;
  return Math.floor(0.89 * (spell.baseCost + spell.portionCost * currentMagic));
}

/** What a gfd cast costs at this max magic. */
const gfdCost = (maxMagic: number): number => Math.floor(0.89 * (3 + 0.05 * maxMagic));

/** What a gfd cast of this spell stores as its chain cost at this max magic. */
function chainCostOf(tag: string, maxMagic: number): number {
  const spell = SPELL_BY_TAG[tag]!;
  return Math.floor(0.89 * (spell.baseCost + spell.portionCost * maxMagic)) / 2;
}

/** Every plain cast action whose name is also the spell it casts. */
const NORMAL_CASTS = [
  ["st", "st"],
  ["hc", "hc"],
  ["scp", "scp"],
  ["cbg", "cbg"],
  ["di", "di"],
] as const;

/** The fthof split: one action per outcome, each needing its own row flag. */
const FTHOF_CASTS = [
  ["fthof-bs", "bs"],
  ["fthof-cf", "cf"],
  ["fthof-ef", "ef"],
] as const;

const GFD_ACTIONS = Actions.filter((action) => action.name.startsWith("g!")).map(
  (action) => action.name,
);

interface Acted {
  /** Whether the action performed rather than cancelling. */
  performed: boolean;
  /** The copy of the state the action ran on. */
  next: RouteState;
  /** That copy afterwards. */
  after: Snapshot;
}

/** Whether two snapshots describe the same state. */
function sameSnapshot(a: Snapshot, b: Snapshot): boolean {
  return (
    a.value === b.value &&
    a.magic === b.magic &&
    a.bs === b.bs &&
    a.cf === b.cf &&
    a.ef === b.ef &&
    a.clot === b.clot &&
    a.onscreens === b.onscreens &&
    a.refills === b.refills &&
    a.pending === b.pending &&
    a.spellIndex === b.spellIndex
  );
}

/**
 * The action-testing mechanism: run `name` on a *copy* of `state` and hold it to
 * the contract every action shares.
 *
 * - The state handed in is never touched; actions always run on a `duplicate()`.
 * - `able()` is the gate: an action that reports itself unable must cancel.
 * - A cancellation is total - no magic, no queue movement, no buffs - so a
 *   refused action is indistinguishable from never having tried it.
 * - Acting has to keep magic non-negative and at or below the metamax; a resolve
 *   refund is the one documented way past that ceiling.
 *
 * Violations are thrown straight away. Pass an `issues` array to collect them
 * instead, so a sweep can report every offender at once (and then assert the
 * array came back empty).
 *
 * Callers assert what the action should have done with the returned state.
 */
function actAction(state: RouteState, name: string, issues?: string[]): Acted {
  const action = actionByName.get(name);
  assert.ok(action !== undefined, `unknown action "${name}"`);
  const report = (message: string): void => {
    if (issues === undefined) {
      assert.fail(message);
    }
    issues.push(message);
  };

  const before = snap(state);
  const next = state.duplicate();
  const performed = next.act(action);
  if (!sameSnapshot(snap(state), before)) {
    report(`probing "${name}" touched the state it was given`);
  }
  const after = snap(next);

  if (!action.able(state) && performed) {
    report(`"${name}" reports itself unable but acted anyway`);
  }
  if (!performed) {
    if (!sameSnapshot(after, before)) {
      report(`"${name}" cancelled but still changed the state`);
    }
    return { performed, next, after };
  }

  if (after.magic < 0) {
    report(`"${name}" drove magic negative (${after.magic})`);
  }
  // Every resolve can refund past the cap (see the magic-guards test below).
  if (after.magic > state.metamax && !name.startsWith("resolve")) {
    report(`"${name}" took magic past the metamax (${after.magic} > ${state.metamax})`);
  }
  return { performed, next, after };
}

describe("route(): action mechanics", () => {
  it("[cost] charges a normal cast floor(0.89 * (base + portion * current magic))", () => {
    for (const [name, tag] of NORMAL_CASTS) {
      const state = routeState(null, [createSpell(B(0.5))], 150, 0, 200, 0);
      const { performed, after } = actAction(state, name);
      assert.equal(performed, true, `${name} has the magic to act at 150`);
      assert.equal(after.magic, 150 - castCostOf(tag, 150), `${name} magic`);
      assert.equal(after.spellIndex, 1, `${name} consumes the row it casts on`);
      assert.equal(after.pending, 0, `${name} queues no resolve`);
    }
  });

  it("[gfd cost] charges floor(0.89 * (3 + 0.05 * max)) and queues one resolve", () => {
    const state = routeState(null, [createSpell(B(0.75))], 200, 0, 200, 0);
    const { performed, next, after } = actAction(state, "g!ra");
    assert.equal(performed, true, "a full pool selects ra for roll 0.75");
    assert.equal(after.magic, 200 - gfdCost(200), "the gfd cast cost");
    assert.equal(after.spellIndex, 1, "the gfd consumes the row it was cast on");
    assert.equal(after.pending, 1, "the gfd queues exactly one resolve");
    assert.deepEqual(
      next.pendingResolves[0],
      { gfdCost: gfdCost(200), chainCost: chainCostOf("ra", 200), spell: SpellIndices.RA },
      "the queued resolve stores the cast cost and the chain cost",
    );
  });

  it("[selection] gives the roll's chunk to the spell at that position of a full pool", () => {
    // A full pool means 8 chunks, so the rolls below are chunks 1..6 of [0, 1).
    const chunks = [
      [0.125, "fthof"],
      [0.25, "st"],
      [0.375, "se"],
      [0.5, "hc"],
      [0.625, "scp"],
      [0.75, "ra"],
    ] as const;
    for (const [roll, tag] of chunks) {
      const state = routeState(null, [createSpell(B(roll))], 200, 0, 200, 0);
      const { performed, next, after } = actAction(state, `g!${tag}`);
      assert.equal(performed, true, `roll ${roll} selects ${tag}`);
      assert.equal(after.magic, 200 - gfdCost(200), `roll ${roll} gfd cost`);
      assert.equal(
        next.pendingResolves[0]!.spell,
        SPELL_BY_TAG[tag]!.index,
        `roll ${roll} resolve`,
      );
    }
  });

  it("[selection] refuses every g! when no spell is castable at all", () => {
    // At 2 magic the pool is empty at every reachable max magic, so the roll has
    // no chunks to divide and no g! can select anything.
    const state = routeState(null, [createSpell(B(0.5))], 2, 0, 2, 0);
    for (const name of GFD_ACTIONS) {
      assert.equal(actAction(state, name).performed, false, `${name} with an empty pool`);
    }
  });

  it("[selection] starts a partial pool's first chunk at the earliest castable spell", () => {
    // At (magic 11, metamax 11) the pool is [cbg, fthof, st, hc, scp, di], so
    // six chunks: roll 0.125 is chunk 0, which belongs to cbg.
    const state = routeState(null, [createSpell(B(0.125))], 11, 0, 11, 0);
    const acted = GFD_ACTIONS.filter((name) => actAction(state, name).performed);
    assert.deepEqual(acted, ["g!cbg"], "chunk 0 of [cbg, fthof, st, hc, scp, di] is cbg");
  });

  it("[selection] gives a partial pool's chunk to the spell at that position", () => {
    // Same pool: roll 0.5 is chunk 3 of six, which is hc.
    const state = routeState(null, [createSpell(B(0.5))], 11, 0, 11, 0);
    const acted = GFD_ACTIONS.filter((name) => actAction(state, name).performed);
    assert.deepEqual(acted, ["g!hc"], "chunk 3 of [cbg, fthof, st, hc, scp, di] is hc");
  });

  it("[selection] raises the max magic to the first value that selects the spell", () => {
    // At (magic 6, metamax 8) di only becomes selectable once the max magic
    // reaches 8, where the pool is [cbg, di] and roll 0.5 is chunk 1. The cast
    // has to be charged for max 8, not for the current magic.
    const state = routeState(null, [createSpell(B(0.5))], 6, 0, 8, 0);
    const { performed, next, after } = actAction(state, "g!di");
    assert.equal(performed, true, "di is selected at max 8");
    assert.equal(after.magic, 6 - gfdCost(8), "the gfd cost is the cost at max 8");
    assert.equal(next.pendingResolves[0]!.chainCost, chainCostOf("di", 8));

    // One point of metamax lower closes that window, and nothing can select di.
    const closed = routeState(null, [createSpell(B(0.5))], 6, 0, 7, 0);
    assert.equal(actAction(closed, "g!di").performed, false, "max 7 cannot select di");
  });

  it("[selection] cancels without touching the state when the spell is not selected", () => {
    const state = routeState(null, [createSpell(B(0.5))], 200, 0, 200, 0);
    const before = snap(state);
    for (const name of GFD_ACTIONS.filter((candidate) => candidate !== "g!hc")) {
      const { performed, after } = actAction(state, name);
      assert.equal(performed, false, `${name} must cancel for roll 0.5`);
      assert.deepEqual(after, before, `${name} must leave the state alone`);
    }
  });

  it("[resolve] settles the oldest queued gfd without consuming a row", () => {
    // Row 0 (roll 0.625) queues scp, row 1 (roll 0.75) queues ra.
    const start = routeState(null, [createSpell(B(0.625)), createSpell(B(0.75))], 200, 0, 200, 0);
    const queuedScp = actAction(start, "g!scp");
    assert.equal(queuedScp.performed, true, "roll 0.625 selects scp");
    const queuedRa = actAction(queuedScp.next, "g!ra");
    assert.equal(queuedRa.performed, true, "roll 0.75 selects ra");
    assert.equal(queuedRa.after.spellIndex, 2, "both gfd casts consumed their row");
    assert.equal(queuedRa.after.pending, 2, "both gfd casts are queued");

    // Oldest first: the scp pays its chain cost. Settling the ra instead would
    // have refunded its gfd cost and moved the magic the other way.
    const settled = actAction(queuedRa.next, "resolve");
    assert.equal(settled.performed, true);
    assert.equal(settled.after.spellIndex, 2, "resolve casts without consuming a row");
    assert.equal(settled.after.pending, 1, "one resolve settles one gfd");
    assert.equal(
      settled.after.magic,
      queuedRa.after.magic - chainCostOf("scp", 200),
      "the scp's chain cost is paid",
    );
  });

  it("[resolve] refunds a gfd's cast cost when it resolves ra", () => {
    const start = routeState(null, [createSpell(B(0.75))], 200, 0, 200, 0);
    const cast = actAction(start, "g!ra");
    assert.equal(cast.performed, true);
    const settled = actAction(cast.next, "resolve");
    assert.equal(settled.performed, true);
    assert.equal(settled.after.magic, 200, "ra hands the gfd cost back");
    assert.equal(settled.after.pending, 0);
  });

  it("[resolve] refunds se only when the row it resolves on does not backfire", () => {
    // The gfd lands on row 0 (roll 0.375 selects se); the resolve reads row 1,
    // which is the row the spell is actually cast on.
    const settle = (nextRoll: number) => {
      const start = routeState(
        null,
        [createSpell(B(0.375)), createSpell(B(nextRoll))],
        200,
        0,
        200,
        0,
      );
      const cast = actAction(start, "g!se");
      assert.equal(cast.performed, true, "roll 0.375 selects se");
      return actAction(cast.next, "resolve");
    };

    const calm = settle(0.1);
    assert.equal(calm.after.magic, 200, "no backfire on the resolve row hands the gfd cost back");

    const misfire = settle(0.9);
    assert.equal(
      misfire.after.magic,
      200 - gfdCost(200) - chainCostOf("se", 200),
      "a backfire on the resolve row pays the se chain instead",
    );
  });

  it("[resolve] refunds the gfd cost when the chain cannot be paid", () => {
    const state = routeState(null, [createSpell(B(0.1))], 5, 0, 200, 0);
    state.addResolve(gfdCost(200), chainCostOf("scp", 200), SpellIndices.SCP);
    const { performed, after } = actAction(state, "resolve");
    assert.equal(performed, true);
    assert.equal(after.magic, 5 + gfdCost(200), "the gfd cost comes back instead of the chain");
    assert.equal(after.pending, 0);
  });

  it("[magic guards] keeps every action at or below the metamax, refunds included", () => {
    const start = routeState(null, [createSpell(B(0.75))], 200, 0, 200, 0);
    const cast = actAction(start, "g!ra");
    const settled = actAction(cast.next, "resolve");
    assert.equal(settled.after.magic, 200, "the refund returns the magic the cast spent");
    assert.ok(settled.after.magic <= start.metamax, "which is still at the cap");

    // The one path past the cap: a refill clamps to it, so the refund that
    // follows has nowhere to land but above it.
    const stock = routeState(null, [createSpell(B(0.75))], 200, 0, 200, 1);
    const castAgain = actAction(stock, "g!ra");
    const refilled = actAction(castAgain.next, "refill");
    assert.equal(refilled.performed, true);
    assert.equal(refilled.after.magic, 200, "the refill clamps at the cap");
    const refunded = actAction(refilled.next, "resolve");
    assert.equal(
      refunded.after.magic,
      200 + gfdCost(200),
      "a refund after a clamped refill is the documented exception",
    );
  });

  it("[di/diB] multiplies the base backfire chance by 0.1 under di and 5 under diB", () => {
    // Base chance 0.15 * 1.11 = 0.1665, so the plain threshold is 0.8335, di's is
    // 0.98335 and diB's is 0.1675.
    const backfires = (buff: "di" | "diB" | null, roll: number): boolean => {
      const state = routeState(null, [createSpell(B(roll))], 200, 0, 200, 0);
      if (buff !== null) {
        state.addBuff(buff);
      }
      return state.backfires(1.11);
    };
    assert.equal(backfires(null, 0.84), true, "plain roll above 1 - 0.1665");
    assert.equal(backfires(null, 0.83), false, "plain roll below it");
    assert.equal(backfires("di", 0.99), true, "di roll above 1 - 0.01665");
    assert.equal(backfires("di", 0.98), false, "di roll below it");
    assert.equal(backfires("diB", 0.17), true, "diB roll above 1 - 0.8325");
    assert.equal(backfires("diB", 0.16), false, "diB roll below it");
  });

  it("[di/diB] floors a gfd resolve's backfire chance at 50%", () => {
    // "50% or the original backfire chance, whichever is larger": with a small
    // chance the floor decides, with diB's inflated chance the original does.
    const backfires = (buff: "diB" | null, roll: number): boolean => {
      const state = routeState(null, [createSpell(B(roll))], 200, 0, 200, 0);
      if (buff !== null) {
        state.addBuff(buff);
      }
      return state.backfiresGFD(1.11);
    };
    assert.equal(backfires(null, 0.6), true, "the 50% floor catches 0.6");
    assert.equal(backfires(null, 0.4), false, "0.4 is inside the floor");
    assert.equal(backfires("diB", 0.2), true, "diB's own chance still beats the floor");
    assert.equal(backfires("diB", 0.1), false, "0.1 is inside diB's chance");
    assert.equal(backfires("diB", 0.6), true, "the floor still applies under diB");
  });

  it("[di/diB] resolves di into di or diB depending on the row it lands on", () => {
    const settle = (roll: number) => {
      const state = routeState(null, [createSpell(B(roll))], 200, 0, 200, 0);
      state.addResolve(gfdCost(200), chainCostOf("di", 200), SpellIndices.DI);
      return actAction(state, "resolve");
    };

    const calm = settle(0.1);
    assert.equal(calm.performed, true);
    assert.equal(calm.next.di, true, "no backfire grants di");
    assert.equal(calm.next.diB, false);

    const misfire = settle(0.9);
    assert.equal(misfire.next.diB, true, "a backfire grants diB instead");
    assert.equal(misfire.next.di, false);
  });
});

/* -------------------------------------------------------------------------- *
 * route(): the fthof split and onscreens
 *
 * Each `fthof` cast spawns one cookie on screen, and every cookie raises the next
 * cast's backfire chance by 15%. `fthof-cf`/`-bs` need the cast to land, so they
 * click the excess cookies away and keep the most the roll survives; `fthof-ef`
 * needs a backfire, so it wants the cookies kept. The three `resolve-fthof-*`
 * actions settle a queued `g!fthof` under the same rules, with the gfd 50%
 * backfire floor on top.
 * -------------------------------------------------------------------------- */

/** Base Force-the-Hand-of-Fate backfire chance at multiplier 1.11. */
const FTHOF_CHANCE = 0.15 * 1.11;

/** The most on-screen cookies a roll can survive and still land a fthof. */
const keepableOnscreens = (roll: number): number =>
  Math.max(0, Math.ceil((1 - FTHOF_CHANCE - roll) / 0.15) - 1);

/** A row that carries only the given fthof outcome. */
const spellFor = (flag: "bs" | "cf" | "ef", gfdRs: number): Partial<Spell> => ({
  bs: flag === "bs",
  cf: flag === "cf",
  ef: flag === "ef",
  gfdRs,
});

/** Spell shorthands for the fthof outcomes that are not plain `bs`. */
const C = (gfdRs: number): Partial<Spell> => ({ cf: true, gfdRs });
const E = (gfdRs: number): Partial<Spell> => ({ ef: true, gfdRs });

/** A state whose row carries `spell`, with one `g!fthof` already queued. */
function queuedFthof(spell: Partial<Spell>, magic = 200): RouteState {
  const state = routeState(null, [createSpell(spell)], magic, 0, 200, 0);
  state.addResolve(gfdCost(200), chainCostOf("fthof", 200), SpellIndices.FTHOF);
  return state;
}

describe("route(): the fthof split and onscreens", () => {
  it("[fthof] each outcome has its own cast, which consumes the row and spawns a cookie", () => {
    for (const [name, flag] of FTHOF_CASTS) {
      // ef needs a backfire, so it is cast on a roll above the plain ceiling.
      const roll = flag === "ef" ? 0.95 : 0.5;
      const state = routeState(null, [createSpell(spellFor(flag, roll))], 150, 0, 200, 0);
      const { performed, next, after } = actAction(state, name);
      assert.equal(performed, true, name);
      assert.equal(after.magic, 150 - castCostOf("fthof", 150), `${name} cost`);
      assert.equal(after.spellIndex, 1, `${name} consumes the row it was cast on`);
      assert.equal(after.pending, 0, `${name} queues no resolve`);
      assert.equal(next.onscreens, 1, `${name} spawns one onscreen`);
      assert.equal(next.bs, flag === "bs" ? 1 : 0, `${name} bs`);
      assert.equal(next.cf, flag === "cf", `${name} cf`);
      assert.equal(next.ef, flag === "ef", `${name} ef`);
    }
  });

  it("[fthof] only the matching row flag opens a cast", () => {
    const rows: Record<"bs" | "cf" | "ef", RouteState> = {
      bs: routeState(null, [createSpell(B(0.5))], 200, 0, 200, 0),
      cf: routeState(null, [createSpell(C(0.5))], 200, 0, 200, 0),
      ef: routeState(null, [createSpell(E(0.95))], 200, 0, 200, 0),
    };

    for (const [name, flag] of FTHOF_CASTS) {
      for (const rowFlag of ["bs", "cf", "ef"] as const) {
        assert.equal(
          actionByName.get(name)!.able(rows[rowFlag]),
          rowFlag === flag,
          `${name} on a ${rowFlag} row`,
        );
      }
    }
  });

  it("[fthof] cf and ef are one-shot while bs stacks", () => {
    const cfHeld = routeState(null, [createSpell(C(0.5))], 200, 0, 200, 0);
    cfHeld.addBuff("cf");
    assert.equal(actionByName.get("fthof-cf")!.able(cfHeld), false);

    const efHeld = routeState(null, [createSpell(E(0.95))], 200, 0, 200, 0);
    efHeld.addBuff("ef");
    assert.equal(actionByName.get("fthof-ef")!.able(efHeld), false);

    const bsHeld = routeState(null, [createSpell(B(0.5))], 200, 0, 200, 0);
    bsHeld.addBuff("bs");
    const stacked = actAction(bsHeld, "fthof-bs");
    assert.equal(stacked.performed, true);
    assert.equal(stacked.next.bs, 2, "bs stacks");
  });

  it("[onscreens] a landing cast keeps the most cookies the roll survives", () => {
    for (const roll of [0.2, 0.5, 0.75]) {
      const kept = keepableOnscreens(roll);
      for (const start of [0, 1, kept, kept + 5]) {
        const state = routeState(null, [createSpell(C(roll))], 200, 0, 200, 0);
        state.onscreens = start;
        const { performed, next } = actAction(state, "fthof-cf");
        assert.equal(performed, true, `roll ${roll}, start ${start}`);
        assert.equal(
          next.onscreens,
          Math.min(start, kept) + 1,
          `roll ${roll} from ${start} cookies`,
        );
      }
    }
  });

  it("[onscreens] a landing cast never drives the count negative", () => {
    for (const roll of [0.05, 0.2, 0.5, 0.8]) {
      const state = routeState(null, [createSpell(B(roll))], 200, 0, 200, 0);
      const { performed, next } = actAction(state, "fthof-bs");
      assert.equal(performed, true, `roll ${roll}`);
      assert.equal(next.onscreens, 1, `roll ${roll} leaves exactly the new cookie`);
    }
  });

  it("[onscreens] ef only fires on a backfire, and cookies make one likelier", () => {
    // 0.5 lands under the plain 0.8335 ceiling, so an empty screen cannot backfire.
    const calm = routeState(null, [createSpell(E(0.5))], 200, 0, 200, 0);
    assert.equal(actionByName.get("fthof-ef")!.able(calm), false);

    // Three cookies push the ceiling down to 0.3835, so the same roll backfires.
    const loaded = routeState(null, [createSpell(E(0.5))], 200, 0, 200, 0);
    loaded.onscreens = 3;
    const { performed, next } = actAction(loaded, "fthof-ef");
    assert.equal(performed, true);
    assert.equal(next.ef, true);
    assert.equal(next.onscreens, 4, "the backfire spawns another cookie");

    // A roll above the plain ceiling backfires with an empty screen too.
    const high = routeState(null, [createSpell(E(0.9))], 200, 0, 200, 0);
    assert.equal(actAction(high, "fthof-ef").performed, true);
  });

  it("[resolve-fthof] cf and bs settle on a landing cast, ef on a backfire", () => {
    const cf = actAction(queuedFthof(C(0.4)), "resolve-fthof-cf");
    assert.equal(cf.performed, true);
    assert.equal(cf.next.cf, true);
    assert.equal(cf.after.spellIndex, 0, "a resolve does not consume the row");
    assert.equal(cf.after.pending, 0, "one resolve settles the queued g!fthof");
    assert.equal(cf.after.magic, 200 - chainCostOf("fthof", 200), "the chain cost is paid");
    assert.equal(cf.next.onscreens, 1, "the resolved cookie lands on screen");

    const bs = actAction(queuedFthof(B(0.4)), "resolve-fthof-bs");
    assert.equal(bs.performed, true);
    assert.equal(bs.next.bs, 1);
    assert.equal(bs.after.pending, 0);

    const ef = actAction(queuedFthof(E(0.6)), "resolve-fthof-ef");
    assert.equal(ef.performed, true);
    assert.equal(ef.next.ef, true);
    assert.equal(ef.after.pending, 0);
  });

  it("[resolve-fthof] a gfd resolve never lands above the 50% backfire floor", () => {
    assert.equal(
      actAction(queuedFthof(C(0.6)), "resolve-fthof-cf").performed,
      false,
      "0.6 backfires for a gfd resolve",
    );

    const ef = actionByName.get("resolve-fthof-ef");
    assert.ok(ef !== undefined);
    assert.equal(ef.able(queuedFthof(E(0.2))), false, "0.2 is inside the floor");
    assert.equal(ef.able(queuedFthof(E(0.6))), true, "0.6 is outside it");
  });

  it("[resolve-fthof] a landing resolve clicks down like a direct cast", () => {
    const state = queuedFthof(C(0.4));
    state.onscreens = 6;
    const { performed, next } = actAction(state, "resolve-fthof-cf");
    assert.equal(performed, true);
    assert.equal(next.onscreens, keepableOnscreens(0.4) + 1);
  });

  it("[resolve-fthof] only a fthof head is settled by the split resolvers", () => {
    const generic = actionByName.get("resolve");
    assert.ok(generic !== undefined);
    assert.equal(generic.able(queuedFthof(C(0.4))), false, "fthof has its own resolvers");

    const other = routeState(null, [createSpell(C(0.4))], 200, 0, 200, 0);
    other.addResolve(gfdCost(200), chainCostOf("ra", 200), SpellIndices.RA);
    assert.equal(actionByName.get("resolve-fthof-cf")!.able(other), false);
    assert.equal(generic.able(other), true, "the generic resolve takes a non-fthof head");
  });

  it("[resolve-fthof] a resolve that cannot pay its chain refunds once and is spent", () => {
    const state = queuedFthof(C(0.4), 5);
    const { performed, after } = actAction(state, "resolve-fthof-cf");
    assert.equal(performed, true);
    assert.equal(after.magic, 5 + gfdCost(200), "the gfd cost comes back instead of the chain");
    assert.equal(after.pending, 0, "the failed resolve is spent, so it cannot refund twice");
  });
});

/* -------------------------------------------------------------------------- *
 * route(): restrictions
 *
 * SI and RB move both halves of the model: SI is a tenth off every spell cost
 * and a tenth onto the backfire chance, RB is a tenth of SI, and the two stack
 * additively. The transmute pool is a function of those same costs, so dropping
 * a restriction can take a spell out of the pool and hand the same roll to a
 * different spell. `DEFAULT_RESTRICTIONS` - SI and RB both slotted - is the
 * profile every other test in this file is written against.
 * -------------------------------------------------------------------------- */

/**
 * The four profiles, each with what it does to a `st` cast at 150 magic
 * (`8 + 0.2 * 150 = 38` before the discount) and to a roll of 0.84, which sits
 * between the x1 backfire ceiling (0.85) and SI's (0.835).
 */
const PROFILES = [
  { flags: { siAllowed: false, rbAllowed: false }, costMult: 1, cost: 38, backfires: false },
  { flags: { siAllowed: true, rbAllowed: false }, costMult: 0.9, cost: 34, backfires: true },
  { flags: { siAllowed: false, rbAllowed: true }, costMult: 0.99, cost: 37, backfires: false },
  { flags: { siAllowed: true, rbAllowed: true }, costMult: 0.89, cost: 33, backfires: true },
] as const;

describe("route(): restrictions", () => {
  it("[restrictions] each profile prices a cast and scales the backfire chance", () => {
    for (const profile of PROFILES) {
      const label = `${profile.flags.siAllowed ? "si" : "no-si"} + ${profile.flags.rbAllowed ? "rb" : "no-rb"}`;
      const state = routeState(null, [createSpell(B(0.84))], 150, 0, 200, 0).setRestrictions(
        profile.flags,
      );

      assert.ok(
        Math.abs(state.costMult - profile.costMult) < 1e-9,
        `${label}: cost multiplier is ${state.costMult}, expected ${profile.costMult}`,
      );
      assert.equal(
        actAction(state, "st").after.magic,
        150 - profile.cost,
        `${label}: a st cast charges floor(cost mult * 38)`,
      );
      assert.equal(
        state.backfires(state.backfireMult),
        profile.backfires,
        `${label}: backfire at roll 0.84`,
      );
    }
  });

  it("[restrictions] a narrower profile hands the same roll to a different transmute", () => {
    // At (magic 5, metamax 5) the gfd cast costs floor(cost mult * 3.25) and a
    // spell is in the pool when 5 >= floor(cost mult * chain) / 2 + that cost.
    // With both discounts that leaves [cbg, di], so roll 0.5 - chunk 1 of 2 -
    // takes di. With neither, only cbg clears its threshold and the roll's one
    // chunk takes cbg instead. This is what pins which pool bit the profile
    // reads: the guide carries all four, and the wrong one still finds a spell.
    const selected = (flags: { siAllowed: boolean; rbAllowed: boolean }): string[] => {
      const state = routeState(null, [createSpell(B(0.5))], 5, 0, 5, 0).setRestrictions(flags);
      return GFD_ACTIONS.filter((name) => actAction(state, name).performed);
    };

    assert.deepEqual(selected({ siAllowed: true, rbAllowed: true }), ["g!di"], "si + rb");
    assert.deepEqual(selected({ siAllowed: true, rbAllowed: false }), ["g!di"], "si only");
    assert.deepEqual(selected({ siAllowed: false, rbAllowed: true }), ["g!cbg"], "rb only");
    assert.deepEqual(selected({ siAllowed: false, rbAllowed: false }), ["g!cbg"], "neither");

    // The cast is priced off the same profile: di costs floor(0.89 * 3.25) = 2
    // with both discounts, and cbg costs floor(1 * 3.25) = 3 with neither.
    const discounted = actAction(routeState(null, [createSpell(B(0.5))], 5, 0, 5, 0), "g!di");
    assert.equal(discounted.performed, true, "the x0.89 pool casts di");
    assert.equal(discounted.after.magic, 5 - 2, "the x0.89 gfd cost");
    assert.equal(discounted.next.pendingResolves[0]!.chainCost, 2.5, "the x0.89 di chain");

    const full = actAction(
      routeState(null, [createSpell(B(0.5))], 5, 0, 5, 0).setRestrictions({
        siAllowed: false,
        rbAllowed: false,
      }),
      "g!cbg",
    );
    assert.equal(full.performed, true, "the x1 pool casts cbg");
    assert.equal(full.after.magic, 5 - 3, "the x1 gfd cost");
    assert.equal(full.next.pendingResolves[0]!.chainCost, 2, "the x1 cbg chain");
  });
});
