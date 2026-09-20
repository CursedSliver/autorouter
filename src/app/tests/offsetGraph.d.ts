/**
 * Types for `offsetGraph.js`, the raw transmutation-table reference.
 *
 * The module is plain JS — it is the graph section lifted out of the original
 * app, with its data half split out so node can drive it — so the surface the
 * table tests use is declared here.
 */

/** Every spell, in catalog order. */
export declare const FULL_GFD_CONFIG: string[];

/** Element-wise array equality; a GFD pool is identified by its tag list. */
export declare function equivalentContent(a1: readonly string[], a2: readonly string[]): boolean;

/** Index of the pool in `arr` equivalent to `item`, or -1 when absent. */
export declare function equivalentIndexOf(
  arr: readonly (readonly string[])[],
  item: readonly string[],
): number;

/** The four multiplier auras the section derives: {1, 0.9, 0.99, 0.89}. */
export declare function auraMatrix(): number[];

/** The raw transmutation table in the graph section's own encoding. */
export interface RawTransmutationTable {
  /** Every distinct pool: `[]` first, the full list second, then widest first. */
  allGFDConfigs: string[][];
  /** How often each pool is reached across the sampled grid. */
  allCounts: number[];
  /** `dataPoints[cur][max]`: four base-100 pool indices, {1, 0.9, 0.99, 0.89} low digit first. */
  dataPoints: number[][];
}

/**
 * Builds a `RawTransmutationTable` over `[0, magicAbsMax]` on both axes.
 *
 * `getPossibleGFDs(currentMagic, maxMagic, mult)` is the raw pool lookup;
 * `minMax` / `maxSample` bound the max-magic window sampled for distinct pools
 * and must cover the grid, or a pool is missing from `allGFDConfigs` and gets
 * encoded as -1.
 */
export declare function buildTransmutationTable(options: {
  getPossibleGFDs: (currentMagic: number, maxMagic: number, mult: number) => string[];
  magicAbsMax: number;
  spells?: string[];
  matrix?: number[];
  minMax?: number;
  maxSample?: number;
}): RawTransmutationTable;
