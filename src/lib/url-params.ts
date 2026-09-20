/**
 * The planner's URL contract. A link can carry the whole form state
 * (`seed`, `casts`, `maxmagic`, `towercount`, `towerlevel`, `refills`, `si`,
 * `rb`, `currentmagic`, `lookahead`) so a route is shareable without re-typing
 * it, and an `execute` switch lets the linked page route the combo as soon as it
 * loads.
 *
 * Reading is deliberately lenient: a parameter that is missing or unparseable is
 * simply reported as absent, and the caller decides on defaults. This module only
 * knows the wire format — it does not touch the DOM or the form.
 */

/** The form values the URL knows how to carry. `null` means "not present". */
export interface PlannerUrlState {
  seed: string | null;
  casts: number | null;
  maxMagic: number | null;
  towerCount: number | null;
  towerLevel: number | null;
  refills: number | null;
  /** Whether the run may assume Supreme Intellect / Reality Bending is slotted. */
  si: boolean | null;
  rb: boolean | null;
  currentMagic: number | null;
  lookahead: number | null;
}

/** A carried state plus the load-time switch that asks the app to route at once. */
export interface PlannerUrlParams extends PlannerUrlState {
  execute: boolean;
}

/** A whole number from the query string, or null while absent or unusable. */
const readInteger = (params: URLSearchParams, key: string): number | null => {
  const raw = params.get(key);

  if (raw === null || raw.trim() === "") return null;

  const value = Number.parseInt(raw, 10);

  return Number.isFinite(value) ? value : null;
};

/** A yes/no switch from the query string, or null while absent or unusable. */
const readBoolean = (params: URLSearchParams, key: string): boolean | null => {
  const raw = params.get(key)?.trim().toLowerCase();

  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;

  return null;
};

/** Parse a query string (with or without its leading "?") into planner values. */
export function readPlannerUrlParams(search: string): PlannerUrlParams {
  const params = new URLSearchParams(search);
  const seed = params.get("seed")?.trim() ?? "";
  const execute = params.get("execute");

  return {
    seed: seed.length > 0 ? seed : null,
    casts: readInteger(params, "casts"),
    maxMagic: readInteger(params, "maxmagic"),
    towerCount: readInteger(params, "towercount"),
    towerLevel: readInteger(params, "towerlevel"),
    refills: readInteger(params, "refills"),
    si: readBoolean(params, "si"),
    rb: readBoolean(params, "rb"),
    currentMagic: readInteger(params, "currentmagic"),
    lookahead: readInteger(params, "lookahead"),
    execute: execute === "true" || execute === "1",
  };
}

/**
 * The shareable form of a state: the same parameters this module reads, with the
 * absent ones left out so the link stays short and its defaults stay implicit.
 * The base URL's own query is replaced, so sharing never carries stale values.
 */
export function plannerShareUrl(base: string, state: PlannerUrlState): string {
  const url = new URL(base);
  const params = new URLSearchParams();

  if (state.seed !== null) params.set("seed", state.seed);

  const add = (key: string, value: number | boolean | null): void => {
    if (value !== null) params.set(key, String(value));
  };

  add("casts", state.casts);
  add("maxmagic", state.maxMagic);
  add("towercount", state.towerCount);
  add("towerlevel", state.towerLevel);
  add("refills", state.refills);
  add("si", state.si);
  add("rb", state.rb);
  add("currentmagic", state.currentMagic);
  add("lookahead", state.lookahead);

  url.search = params.toString();

  return url.toString();
}
