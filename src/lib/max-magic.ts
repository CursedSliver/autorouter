/**
 * The three numbers behind "maximum max magic" are the same fact told three
 * ways: max magic is a function of the tower count and the tower level, so the
 * form keeps them in step and this module owns the arithmetic.
 */
import { towerCountToMaxMagic } from "../app/route/seedgen";

export const MIN_TOWER_COUNT = 1;
export const MAX_TOWER_COUNT = 4939;
export const MIN_TOWER_LEVEL = 1;
export const MAX_TOWER_LEVEL = 18;

export const clampTowerCount = (towers: number): number =>
  Math.min(Math.max(Math.round(towers), MIN_TOWER_COUNT), MAX_TOWER_COUNT);

export const clampTowerLevel = (level: number): number =>
  Math.min(Math.max(Math.round(level), MIN_TOWER_LEVEL), MAX_TOWER_LEVEL);

/**
 * The fewest towers whose max magic reaches `maxMagic` at `level`. Max magic
 * grows with the tower count, so a binary search finds the crossing: the exact
 * count that lands on the target may not exist, and the request is the smallest
 * one that at least reaches it.
 */
export function towersForMaxMagic(maxMagic: number, level: number): number {
  const target = Math.max(Math.round(maxMagic), 1);
  const lvl = clampTowerLevel(level);

  // Even the largest city can fall short of the request; there is nothing
  // smaller to hand back than the cap itself.
  if (towerCountToMaxMagic(MAX_TOWER_COUNT, lvl) < target) return MAX_TOWER_COUNT;

  let low = MIN_TOWER_COUNT;
  let high = MAX_TOWER_COUNT;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);

    if (towerCountToMaxMagic(mid, lvl) >= target) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}
