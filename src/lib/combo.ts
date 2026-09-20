/**
 * Ways of naming the banked effects of a route. Both the live "best combo"
 * counter and the combo-instructions header speak this shorthand, so it lives in
 * one place instead of being restated per caller.
 */
import type { RouteCombo } from "../app/route/route";

/**
 * The banked effects as a fixed-order shorthand: bs -> ef -> cf -> clot, one entry
 * per buff that landed. `bs` carries how many instances landed. This is the live
 * counter's voice, where the row has to stay narrow.
 */
export const shorthandCombo = (combo: RouteCombo): string => {
  const parts = [
    combo.bs > 0 ? `${combo.bs > 1 ? combo.bs : ""}BS` : null,
    combo.ef ? "EF" : null,
    combo.cf ? "CF" : null,
    combo.clot ? "CLOT" : null,
  ].filter((buff): buff is string => buff !== null);

  return parts.length > 0 ? parts.join("+") : "none";
};

/**
 * The same combo with every shorthand expanded, for the result card that leads
 * with it: "3 Building Specials + Elder Frenzy + Click Frenzy + Clot".
 */
export const fullCombo = (combo: RouteCombo): string => {
  const parts = [
    combo.bs > 0 ? `${combo.bs} Building Special${combo.bs > 1 ? "s" : ""}` : null,
    combo.ef ? "Elder Frenzy" : null,
    combo.cf ? "Click Frenzy" : null,
    combo.clot ? "Clot" : null,
  ].filter((buff): buff is string => buff !== null);

  return parts.length > 0 ? parts.join(" + ") : "none";
};
