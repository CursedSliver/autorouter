import type { Spell } from "../app/route/route";

/** Boolean columns of `Spell`, in table order. */
export const SPELL_FLAGS = ["bs", "cf", "ef"/*, "dfBs"*/] as const;

export type SpellFlag = (typeof SPELL_FLAGS)[number];

export function createSpell(overrides: Partial<Spell> = {}): Spell {
  return { bs: false, cf: false, ef: false, dfBs: false, gfdRs: 0, ...overrides };
}

/** The queue the table starts with: [cf, -, bs, -, cf, cf, bs+ef, cf, bs]. */
export const DEFAULT_SPELLS: readonly Spell[] = [
  createSpell({ cf: true, gfdRs: 0.2116 }),
  createSpell({ gfdRs: 0.6592 }),
  createSpell({ bs: true, gfdRs: 0.1863 }),
  createSpell({ gfdRs: 0.3853 }),
  createSpell({ cf: true, gfdRs: 0.4858 }),
  createSpell({ cf: true, gfdRs: 0.1943 }),
  createSpell({ bs: true, ef: true, gfdRs: 0.1946 }),
  createSpell({ cf: true, gfdRs: 0.4837 }),
  createSpell({ bs: true, gfdRs: 0.9555 }),
];

export function isSpellFlag(value: string | undefined): value is SpellFlag {
  return value === "bs" || value === "cf" || value === "ef" || value === "dfBs";
}

/** gfdRs is a roll in [0, 1); keep it inside the range the table advertises. */
export function clampRoll(value: number): number {
  if (!Number.isFinite(value)) return 0;

  return Math.min(Math.max(value, 0), 0.99);
}

/**
 * Mult per Building Special: the multiplier the player gets from one Building
 * Special, which is what that effect is worth. The form asks for it in these
 * terms and clamps it to this range; the score the search runs on is derived
 * from it by `bsScoreFor`.
 */
export const MIN_BS_MULT = 2;
export const MAX_BS_MULT = 500;
/** The multiplier assumed when the player does not say: a x80 Building Special. */
export const DEFAULT_BS_MULT = 80;

/** `mult` as the form owns it: a whole number inside the range the scale covers. */
export const clampBsMult = (mult: number): number =>
  Math.min(Math.max(Math.round(mult), MIN_BS_MULT), MAX_BS_MULT);

/**
 * What one Building Special scores at this multiplier. The scale counts 20
 * units per decade - a x10 Building Special is worth 20 - so a BS worth `mult`
 * scores `round(20 * log10(mult))`. The result is a whole number, like every
 * other term of the score.
 */
export const bsScoreFor = (mult: number): number =>
  Math.round(Math.log10(clampBsMult(mult)) * 20);
