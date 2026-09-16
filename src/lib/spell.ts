import type { Spell } from "../app/route/route";

/** Boolean columns of `Spell`, in table order. */
export const SPELL_FLAGS = ["bs", "cf", "ef"/*, "dfBs"*/] as const;

export type SpellFlag = (typeof SPELL_FLAGS)[number];

export function createSpell(overrides: Partial<Spell> = {}): Spell {
  return { bs: false, cf: false, ef: false, dfBs: false, gfdRs: 0, ...overrides };
}

/** [nothing, nothing, bs, cf, ef] */
export const DEFAULT_SPELLS: readonly Spell[] = [
  createSpell(),
  createSpell(),
  createSpell({ bs: true }),
  createSpell({ cf: true }),
  createSpell({ ef: true }),
];

export function isSpellFlag(value: string | undefined): value is SpellFlag {
  return value === "bs" || value === "cf" || value === "ef" || value === "dfBs";
}

/** gfdRs is a roll in [0, 1); keep it inside the range the table advertises. */
export function clampRoll(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(Math.max(value, 0), 0.99);
}
