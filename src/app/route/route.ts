import type { PossibleEvaluations } from "./microrouter";
import routeBounds from "./microrouter";
import { maxMagicToTowerCount } from "./seedgen";
import { RangedTransmuteGuides, getRangeFromRS } from "./tables";

export interface Spell {
    bs: boolean;
    cf: boolean;
    ef: boolean;
    dfBs: boolean; // Disabled for now, implementing later
    gfdRs: number;
}
export enum SpellIndices {
    CBG = 0,
    FTHOF = 1,
    ST = 2,
    SE = 3,
    HC = 4,
    SCP = 5,
    RA = 6,
    DI = 7
}
export interface PolishInstructions {
    // For anything more advanced refer to the polish.ts file, where ids are hardcoded
    text: string;
    icon: [number, number, string];
    towerCounts: (state: RouteState, lvl: number) => [number, number]; // [min, max)
    /**
     * The max magic the step has to be run at, or null when the step does not
     * care (a resolve's price was fixed when its GFD was cast). Omitted, it is
     * the state's own magic, which is what a cast is priced off. A tower level
     * cannot sell below one tower's worth of max magic, so a step that asks for
     * less than that cannot be played and the instructions say so.
     */
    requiredMagic?: (state: RouteState) => number | null;
    color: string;
}
enum WTChangeFlags {
    NONE, // Does not change wizard tower count
    BEST, // Reducing wizard tower count will grant a boost
    OFTEN, // Changing wizard tower count is sometimes required to make it work
    ABOVE_MAX, // Only change wizard tower count if magic would overflow, changes to a special value that accomodates for the next cast?
    MANDATORY // Must change wizard tower count
}
export interface Action {
    name: string; // in generated actions the name contains the parameters separated by the dash
    invoke: (state: RouteState) => unknown;
    able: (state: RouteState) => boolean; // is called before a new state object is duplicated therefore do not mutate state here
    wtChange: WTChangeFlags;
    maxMagicTo?: (state: RouteState) => number | -1; // Differs per wtChange flag. 
    // Called before invoke on BEST, MANDATORY, and OFTEN, not called on NONE and ABOVE_MAX
    gfdCost?: (state: RouteState) => number;
    polish?: PolishInstructions;
}
export const Actions: Action[] = [
    {
        name: 'preComboSkip',
        invoke: state => state.increment(),
        able: state => (!state.parent || state.action === 'preComboSkip'),
        wtChange: WTChangeFlags.NONE
    },
    {
        name: 'fthof-cf',
        invoke: state => { 
            // the cast consumes the entry it is cast on, so the effect must be read before it is consumed
            const spell = state.peek();
            if (!spell) { return Symbol.for('Cancel action'); }

            // Click onscreens as little as possible to make it not backfire
            const chance = state.backfireChance(state.backfireMult);
            if (spell.gfdRs >= (1 - chance)) {
                // Can never succeed
                return Symbol.for('Cancel action');
            }
            // Click the cookies that would push the roll into a backfire.
            const kept = Math.max(0, Math.ceil((1 - chance - spell.gfdRs) / 0.15) - 1);
            state.onscreens = Math.min(state.onscreens, kept);
            
            state.castSpell(10, 0.6); 
            state.addBuff('cf');
            state.onscreens++;
        },
        gfdCost: state => state.getCost(10, 0.6),
        able: state => state.currentMagic >= state.getCost(10, 0.6) && !!(state.peek() && state.peek()!.cf) && !state.cf,
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast FtHoF',
            icon: [22, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#fdd236'
        }
    },
    {
        name: 'fthof-ef',
        invoke: state => { 
            const spell = state.peek();
            if (!spell) { return Symbol.for('Cancel action'); }
            state.castSpell(10, 0.6); 
            state.addBuff('ef');
            state.onscreens++;
        },
        gfdCost: state => state.getCost(10, 0.6),
        able: state => state.currentMagic >= state.getCost(10, 0.6) && state.backfiresFthof(state.backfireMult) && !!(state.peek() && state.peek()!.ef) && !state.ef,
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast FtHoF',
            icon: [22, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#fdd236'
        }
    },
    {
        name: 'fthof-bs',
        invoke: state => { 
            const spell = state.peek();
            if (!spell) { return Symbol.for('Cancel action'); }

            const chance = state.backfireChance(state.backfireMult);
            if (spell.gfdRs >= (1 - chance)) {
                return Symbol.for('Cancel action');
            }
            const kept = Math.max(0, Math.ceil((1 - chance - spell.gfdRs) / 0.15) - 1);
            state.onscreens = Math.min(state.onscreens, kept);
            
            state.castSpell(10, 0.6); 
            state.addBuff('bs');
            state.onscreens++;
        },
        gfdCost: state => state.getCost(10, 0.6),
        able: state => state.currentMagic >= state.getCost(10, 0.6) && !!(state.peek() && state.peek()!.bs),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast FtHoF',
            icon: [22, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#fdd236'
        }
    },
    // Note: metamax max 200
    {
        name: 'g!fthof',
        invoke: state => tryCastGFDTo(1, state, 10, 0.6),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 1), lvl),
            requiredMagic: state => getTransmuteMax(state, 1),
            color: '#fb6914'
        }
    },
    {
        name: 'resolve',
        invoke: state => state.resolve(),
        able: state => !!state.pendingResolves.length && state.pendingResolves[0]!.spell !== SpellIndices.FTHOF,
        wtChange: WTChangeFlags.ABOVE_MAX,
        polish: {
            text: 'Resolve GFD',
            icon: [17, 14, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            requiredMagic: () => null,
            color: '#fb6914'
        }
    },
    {
        name: 'resolve-fthof-cf',
        invoke: state => {
            const resolve = state.pendingResolves[0];
            if (!resolve || !state.peek()) { return Symbol.for('Cancel action'); }
            if (resolve.chainCost > state.currentMagic) {
                state.currentMagic += resolve.gfdCost;
                state.pendingResolves.shift();
                return;
            }

            const roll = state.peek()!.gfdRs;
            const chance = state.backfireChance(state.backfireMult);
            // A gfd resolve never backfires on less than a 50% chance.
            if (roll >= 1 - Math.max(chance, 0.5)) {
                return Symbol.for('Cancel action');
            }
            const kept = Math.max(0, Math.ceil((1 - chance - roll) / 0.15) - 1);
            state.onscreens = Math.min(state.onscreens, kept);
            state.currentMagic -= resolve.chainCost;

            state.addBuff('cf');
            state.onscreens++;
            state.pendingResolves.shift();
        },
        able: state => state.pendingResolves[0]?.spell === SpellIndices.FTHOF && !!(state.peek() && state.peek()!.cf) && !state.cf,
        wtChange: WTChangeFlags.ABOVE_MAX,
        polish: {
            text: 'Resolve GFD',
            icon: [17, 14, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            requiredMagic: () => null,
            color: '#fb6914'
        }
    },
    {
        name: 'resolve-fthof-ef',
        invoke: state => {
            const resolve = state.pendingResolves[0];
            if (!resolve || !state.peek()) { return Symbol.for('Cancel action'); }
            if (resolve.chainCost > state.currentMagic) {
                state.currentMagic += resolve.gfdCost;
                state.pendingResolves.shift();
                return;
            }
            state.currentMagic -= resolve.chainCost;
            state.addBuff('ef');
            state.onscreens++;
            state.pendingResolves.shift();
        },
        able: state => state.pendingResolves[0]?.spell === SpellIndices.FTHOF && state.backfiresGFDFthof(state.backfireMult) && !!(state.peek() && state.peek()!.ef) && !state.ef,
        wtChange: WTChangeFlags.ABOVE_MAX,
        polish: {
            text: 'Resolve GFD',
            icon: [17, 14, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            requiredMagic: () => null,
            color: '#fb6914'
        }
    },
    {
        name: 'resolve-fthof-bs',
        invoke: state => {
            const resolve = state.pendingResolves[0];
            if (!resolve || !state.peek()) { return Symbol.for('Cancel action'); }
            if (resolve.chainCost > state.currentMagic) {
                state.currentMagic += resolve.gfdCost;
                state.pendingResolves.shift();
                return;
            }

            const roll = state.peek()!.gfdRs;
            const chance = state.backfireChance(state.backfireMult);
            // A gfd resolve never backfires on less than a 50% chance.
            if (roll >= 1 - Math.max(chance, 0.5)) {
                return Symbol.for('Cancel action');
            }
            const kept = Math.max(0, Math.ceil((1 - chance - roll) / 0.15) - 1);
            state.onscreens = Math.min(state.onscreens, kept);
            state.currentMagic -= resolve.chainCost;

            state.addBuff('bs');
            state.onscreens++;
            state.pendingResolves.shift();
        },
        able: state => state.pendingResolves[0]?.spell === SpellIndices.FTHOF && !!(state.peek() && state.peek()!.bs),
        wtChange: WTChangeFlags.ABOVE_MAX,
        polish: {
            text: 'Resolve GFD',
            icon: [17, 14, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            requiredMagic: () => null,
            color: '#fb6914'
        }
    },
    {
        name: 'g!ra',
        invoke: state => tryCastGFDTo(6, state, 20, 0.1),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 6), lvl),
            requiredMagic: state => getTransmuteMax(state, 6),
            color: '#fb6914'
        }
    },
    {
        name: 'g!se',
        invoke: state => tryCastGFDTo(3, state, 20, 0.75),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 3), lvl),
            requiredMagic: state => getTransmuteMax(state, 3),
            color: '#fb6914'
        }
    },
    {
        name: 'g!hc',
        invoke: state => tryCastGFDTo(4, state, 10, 0.1),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 4), lvl),
            requiredMagic: state => getTransmuteMax(state, 4),
            color: '#fb6914'
        }
    },
    {
        name: 'g!di',
        invoke: state => tryCastGFDTo(7, state, 5, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 7), lvl),
            requiredMagic: state => getTransmuteMax(state, 7),
            color: '#fb6914'
        }
    },
    {
        name: 'hc',
        invoke: state => state.castSpell(10, 0.1),
        gfdCost: state => state.getCost(10, 0.1),
        able: state => state.currentMagic >= state.getCost(10, 0.1),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast HC',
            icon: [25, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#bf58ff'
        }
    }, 
    {
        name: 'di',
        invoke: state => { 
            const backfires = state.backfires(state.backfireMult);
            state.castSpell(5, 0.2);
            if (!backfires) {
                state.addBuff('di');
            } else {
                state.addBuff('diB');
            }
        },
        gfdCost: state => state.getCost(5, 0.2),
        able: state => state.currentMagic >= state.getCost(5, 0.2),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast DI',
            icon: [29, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#bf58ff'
        }
    },
    {
        name: 'cbg',
        invoke: state => { 
            if (state.backfires(state.backfireMult)) {
                state.addBuff('clot');
            }
            state.castSpell(2, 0.4);
        },
        gfdCost: state => state.getCost(2, 0.4),
        able: state => state.currentMagic >= state.getCost(2, 0.4),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast CBG',
            icon: [21, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#bf58ff'
        }
    },
    {
        name: 'fthof-none',
        invoke: state => {
            state.castSpell(10, 0.6);
            state.onscreens++;
        },
        able: state => state.currentMagic >= state.getCost(10, 0.6),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast FtHoF',
            icon: [22, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#fdd236'
        }
    },
    {
        name: 'st',
        invoke: state => state.castSpell(8, 0.2),
        gfdCost: state => state.getCost(8, 0.2),
        able: state => state.currentMagic >= state.getCost(8, 0.2),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast ST',
            icon: [23, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#bf58ff'
        }
    },
    {
        name: 'scp',
        invoke: state => state.castSpell(10, 0.2),
        gfdCost: state => state.getCost(10, 0.2),
        able: state => state.currentMagic >= state.getCost(10, 0.2),
        wtChange: WTChangeFlags.BEST,
        maxMagicTo: state => state.currentMagic,
        polish: {
            text: 'Cast SCP',
            icon: [26, 11, 'icons.png'],
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic, lvl),
            color: '#bf58ff'
        }
    },
    {
        name: 'refill',
        invoke: state => state.refill(),
        // at exactly metamax a refill spends a charge for no magic, which is strictly dominated
        able: state => state.refills > 0 && state.currentMagic !== state.metamax,
        wtChange: WTChangeFlags.OFTEN,
        maxMagicTo: state => Math.max(state.currentMagic + 100, state.maxMagic),
        polish: {
            text: 'Refill magic',
            icon: [29, 14, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(state.currentMagic + 100, lvl),
            // The refill has to hold the magic it restores, so it is priced one
            // chunk above the state's own magic.
            requiredMagic: state => state.currentMagic + 100,
            color: '#ffffff'
        }
    },
    {
        name: 'g!st',
        invoke: state => tryCastGFDTo(2, state, 8, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 2), lvl),
            requiredMagic: state => getTransmuteMax(state, 2),
            color: '#fb6914'
        }
    },
    {
        name: 'g!cbg',
        invoke: state => tryCastGFDTo(0, state, 2, 0.4),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 0), lvl),
            requiredMagic: state => getTransmuteMax(state, 0),
            color: '#fb6914'
        }
    },
    {
        name: 'g!scp',
        invoke: state => tryCastGFDTo(5, state, 10, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1),
        wtChange: WTChangeFlags.OFTEN,
        polish: {
            text: 'Cast GFD',
            icon: [27, 11, 'icons.png'], 
            towerCounts: (state, lvl) => maxMagicToTowerCount(getTransmuteMax(state, 5), lvl),
            requiredMagic: state => getTransmuteMax(state, 5),
            color: '#fb6914'
        }
    }
];
function tryCastGFDTo(spellIndex: SpellIndices, state: RouteState, baseCost: number, portionCost: number) {
    const spell = state.peek();
    if (!spell) { return Symbol.for('Cancel action'); }
    const range = getRangeFromRS(spell.gfdRs);
    if (range == undefined) { return Symbol.for('Cancel action'); }
    const row = RangedTransmuteGuides[range]![spellIndex][state.currentMagic];
    if (!row) { return Symbol.for('Cancel action'); }
    const offset = 1 << (3 - (state.restrictions.siAllowed ? 1 : 0) - (state.restrictions.rbAllowed ? 2 : 0));
    for (let i = Math.max(Math.ceil(state.currentMagic), state.restrictions.minMaxMagic); i <= state.metamax; i++) {
        if (row[i]! & offset) {  
            state.addResolve(state.castSpell(3, 0.05, i), 
                Math.floor(state.costMult * (baseCost + portionCost * i)) / 2, 
                spellIndex);
            return Symbol.for('Successful action'); 
        }
    }
    return Symbol.for('Cancel action');
}
function getTransmuteMax(state: RouteState, spellIndex: SpellIndices, mask?: 1 | 2 | 4 | 8): number {
    const range = getRangeFromRS(state.peek()!.gfdRs);
    if (range === undefined) { return NaN; }
    if (!mask) {
        mask = 1 << (3 - (state.restrictions.siAllowed ? 1 : 0) - (state.restrictions.rbAllowed ? 2 : 0));
    }
    // The magic before the cast comes from the state this one descends from. It is
    // always there for an action; the fallback only covers the unreachable case of
    // reading the no-actions root itself.
    const anchor = state.parent ?? state;
    const row = RangedTransmuteGuides[range]![spellIndex][anchor.currentMagic];
    if (!row) { return NaN; }
    for (let i = Math.max(Math.ceil(state.currentMagic), state.restrictions.minMaxMagic); i <= state.metamax; i++) {
        if (row[i]! & mask) {
            return i;
        }
    }
    return NaN;
}
interface GFDPendingResolve {
    gfdCost: number;
    chainCost: number;
    spell: SpellIndices;
}
/** One action of a route, with the magic the state holds once it has been applied. */
export interface RouteStep {
    action: string;
    magic: number;
}
/**
 * What one Building Special scores when the caller does not name a multiplier:
 * the form's own default, which the score scale puts at 20.
 */
//const DEFAULT_BS_SCORE = bsScoreFor(DEFAULT_BS_MULT);
export class RouteState {
    constructor(public parent: RouteState | null, 
        public spells: Spell[], 
        public currentMagic: number, 
        public maxMagic: number,
        public spellIndex: number, 
        public metamax: number, 
        public refills: 0 | 1 | 2,
        public valueEvaluationList: Record<PossibleEvaluations, number>[][] | null = null,
        public restrictions: RouteInput["restrictions"]) {
        this.setRestrictions(restrictions);
    }
    peek() {
        return this.spells[this.spellIndex];
    }
    increment() {
        return this.spells[this.spellIndex++];
    }
    ended() {
        return this.spellIndex >= this.spells.length;
    }
    static initializeValueEvaluationList(spells: Spell[], restrictions: RouteInput["restrictions"]) {
        return routeBounds(spells, { bsScore: restrictions.bsScore });
    }
    timeSteps: number = 0; // Amount of max magic updates taken, if update max magic then must update time step
    updateMaxMagic(max: number) {
        this.timeSteps++;
        this.maxMagic = max;
    }
    backfireMult: 1 | 1.01 | 1.1 | 1.11 = 1;
    costMult: 1 | 0.99 | 0.9 | 0.89 = 1;
    setRestrictions(restrictions: RouteInput["restrictions"]) {
        this.restrictions = restrictions;
        this.backfireMult = 1 + (restrictions.siAllowed ? 0.1 : 0) + (restrictions.rbAllowed ? 0.01 : 0) as (1 | 1.01 | 1.1 | 1.11);
        this.costMult = 1 - (restrictions.siAllowed ? 0.1 : 0) - (restrictions.rbAllowed ? 0.01 : 0) as (1 | 0.99 | 0.9 | 0.89);
        return this;
    }
    currentMaxValue() {
        const val = this.currentValue();
        if (!this.valueEvaluationList || !this.valueEvaluationList[this.spellIndex] || this.spellIndex >= this.valueEvaluationList.length) { return NaN; }
        let gfthofAmounts = 0;
        for (let i in this.pendingResolves) {
            if (this.pendingResolves[i]!.spell === SpellIndices.FTHOF) {
                gfthofAmounts++;
            }
        }
        if (!this.valueEvaluationList[this.spellIndex]![gfthofAmounts]) {
            return NaN;
        }
        return val + this.valueEvaluationList[this.spellIndex]![gfthofAmounts]![(this.cf?'cf':'')+(this.ef?'ef':'')+'-' as PossibleEvaluations];
    }
    action: string | null = null;
    act(action: Action) {
        if (action.invoke(this) === Symbol.for('Cancel action')) { return false; };
        this.action = action.name;
        return true;
    }
    pendingResolves: GFDPendingResolve[] = [];
    addResolve(gfdCost: number, chainCost: number, spellType: SpellIndices) {
        this.pendingResolves.push({ gfdCost, chainCost, spell: spellType });
    }
    backfireChance(mult: number) {
        return 0.15 * mult * (this.di ? 0.1 : 1) * (this.diB ? 5 : 1);
    }
    backfires(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs >= (1 - this.backfireChance(mult));
    }
    backfiresFthof(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs >= (1 - this.backfireChance(mult) - 0.15 * this.onscreens);
    }
    backfiresGFD(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs >= Math.min(1 - this.backfireChance(mult), 0.5);
    }
    backfiresGFDFthof(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs >= Math.min(1 - this.backfireChance(mult) - 0.15 * this.onscreens, 0.5);
    }
    getCost(base: number, portion: number, max?: number) {
        return Math.floor(this.costMult * (base + portion * Math.max(max ?? Math.ceil(this.currentMagic), this.restrictions.minMaxMagic)));
    }
    castArbitrary(magic: number) {
        this.currentMagic -= magic;
        this.increment();
        return magic;
    }
    castSpell(base: number, portion: number, max?: number) {
        const cost = this.getCost(base, portion, max);
        this.currentMagic -= cost;
        this.increment();
        return cost;
    }
    resolve() {
        const gfd = this.pendingResolves.shift();
        if (!gfd) { return false; }
        
        if (gfd.spell === SpellIndices.RA || (gfd.spell === SpellIndices.SE && !this.backfiresGFD(this.backfireMult))) { 
            this.currentMagic += gfd.gfdCost;            
        } else if (this.currentMagic >= gfd.chainCost) { 
            this.currentMagic -= gfd.chainCost; 
            if (gfd.spell === SpellIndices.DI) {
                const backfires = this.backfiresGFD(this.backfireMult);
                if (!backfires) {
                    this.addBuff('di');
                } else {
                    this.addBuff('diB');
                }
            } else if (gfd.spell === SpellIndices.CBG) {
                if (this.backfiresGFD(this.backfireMult)) {
                    this.addBuff('clot');
                }
            }
        } else {
            this.currentMagic += gfd.gfdCost;
        }
        return true;
    }
    bs: number = 0;
    cf: boolean = false;
    ef: boolean = false; 
    clot: boolean = false;
    di: boolean = false;
    diB: boolean = false;
    onscreens: number = 0;
    addBuff(buff: 'bs' | 'cf' | 'ef' | 'clot' | 'di' | 'diB' ) {
        switch (buff) {
            case 'bs':
                this.bs++;
                break;
            case 'cf':
                this.cf = true;
                break;
            case 'ef':
                this.ef = true;
                break;
            case 'clot':
                this.clot = true;
                break;
            case 'di':
                this.di = true;
                this.diB = false;
                break;
            case 'diB':
                this.diB = true;
                this.di = false;
                break;
        }
        this.computeCurrent();
    }
    _currentValue = 0;
    /**
     * The score of the buffs banked so far: one Building Special is worth
     * `bsScore` and stacks, a Click Frenzy 58, an Elder Frenzy 56 and a clot -6.
     * Every term is a whole number, so nothing about the ranking can turn on a
     * rounding error.
     */
    computeCurrent() {
        this._currentValue = this.bs * this.restrictions.bsScore + (this.cf?58:0) + (this.ef?56:0) - (this.clot?6:0);
    }
    currentValue() {
        return this._currentValue;
    }
    /**
     * The actions taken to reach this state, oldest first: the route so far. Each
     * step carries the magic left behind by its action, so the last step always
     * agrees with this state's own `currentMagic`.
     */
    history(): RouteStep[] {
        const steps: RouteStep[] = [];
        let pointer: RouteState | null = this;
        while (pointer) {
            if (pointer.action !== null) {
                steps.push({ action: pointer.action, magic: pointer.currentMagic });
            }
            pointer = pointer.parent;
        }
        return steps.reverse();
    }
    indexedParent(spellIndex: number): RouteState | null {
        let pointer: RouteState = this;
        while(pointer.parent) {
            if (pointer.parent.spellIndex < spellIndex) {
                return pointer;
            }
            pointer = pointer.parent;
        }
        
        if (pointer.spellIndex === spellIndex) {
            return pointer;
        } else {
            return null;
        }
    }
    indexedParentLatest(spellIndex: number): RouteState | null {
        let pointer: RouteState = this;
        while(pointer.parent) {
            if (pointer.spellIndex === spellIndex) {
                return pointer;
            }
            pointer = pointer.parent;
        }
        return null;
    }

    refill() {
        if (this.refills <= 0) { return; }
        this.refills--;
        this.currentMagic += 100;
        this.currentMagic = Math.min(this.currentMagic, this.metamax);
    }

    duplicate() {
        const n = new RouteState(this, 
            this.spells, 
            this.currentMagic, 
            this.maxMagic,
            this.spellIndex, 
            this.metamax, 
            this.refills,
            this.valueEvaluationList,
            this.restrictions);
        n.bs = this.bs;
        n.cf = this.cf;
        n.ef = this.ef;
        n.di = this.di;
        n.diB = this.diB;
        n.clot = this.clot;
        n.pendingResolves = this.pendingResolves.length > 0 ? this.pendingResolves.map(gfd => ({ ...gfd })) : [];
        n.onscreens = this.onscreens;
        n.timeSteps = this.timeSteps;
        n.maxMagic = this.maxMagic;
        n.computeCurrent();
        return n;
    }
}
interface RouteInfo {
    goal: number;
    /** Branches expanded so far, and the count at which the next report is due. */
    steps: number;
    nextReport: number;
    /** Best score of any state the search has reached; the value a halt would report. */
    bestScore: number;
    /** The banked effects of the state that reached `bestScore`, for a live combo. */
    bestCombo: RouteCombo;
    onProgress: ((progress: RouteProgress) => void) | null;
}
/** MS between progress reports: one report costs a message and a DOM write. */
const PROGRESS_INTERVAL = 50;
interface RouteInput {
    spells: Spell[],
    goal: number,
    metamax: number,
    stepLimit?: number, // deprecated
    currentMagic: number,
    startingRefills: 0 | 1 | 2,
    restrictions: {
        siAllowed: boolean;
        rbAllowed: boolean;
        /** What one Building Special is worth, from the caller's own multiplier. */
        bsScore: number;
        minMaxMagic: number;
    }
    index?: number,
    onProgress?: (progress: RouteProgress) => void
}
/** The banked effects a state carries: `bs` stacks, the rest are one-shot. */
export interface RouteCombo {
    bs: number;
    cf: boolean;
    ef: boolean;
    clot: boolean;
}
/** Cheap sample of a running search. `score` is reachable but not necessarily optimal. */
export interface RouteProgress {
    /** Branches expanded so far. */
    steps: number;
    /** Best score reached so far - what stopping the search right now would report. */
    score: number;
    /** The `combo` held by the state that reached `score`. */
    combo: RouteCombo;
}
function route(info: RouteInput) {
    // The restrictions come first: they carry the weights the ceiling is scored
    // with, so the value evaluation list has to be built after them.
    const root = new RouteState(null, 
        info.spells, 
        info.currentMagic, 
        info.currentMagic,
        info.index ?? 0, 
        info.metamax, 
        info.startingRefills,
        RouteState.initializeValueEvaluationList(info.spells, info.restrictions),
        info.restrictions
    );
    const routeInfo: RouteInfo = { 
        goal: info.goal, 
        steps: 0,
        nextReport: PROGRESS_INTERVAL,
        bestScore: 0,
        bestCombo: { bs: 0, cf: false, ef: false, clot: false },
        onProgress: info.onProgress ?? null
    };
    const best = iterate(
        root, 
        routeInfo, 
        new RouteState(null, [], 0, 0, 0, info.metamax, 0, RouteState.initializeValueEvaluationList(info.spells, info.restrictions), info.restrictions)
    );
    reportProgress(routeInfo);
    return best;
}

function reportProgress(routeInfo: RouteInfo) {
    if (!routeInfo.onProgress) { return; }
    routeInfo.onProgress({ steps: routeInfo.steps, score: routeInfo.bestScore, combo: routeInfo.bestCombo });
}
function iterate(routeState: RouteState, routeInfo: RouteInfo, bestState: RouteState) {
    if (routeState.ended()) {
        return routeState;
    }
    // If we are on the same index after an action
    let equivalentCurrentBest = bestState.indexedParentLatest(routeState.spellIndex - 1); 
    // If we are on the next index after an action
    let equivalentNextBest = bestState.indexedParentLatest(routeState.spellIndex);
    for (const act of Actions) {
        if (!act.able(routeState)) {
            continue;
        }
        const next = routeState.duplicate();
        if (!next.act(act)) { 
            continue;
        }
        // Yes, this is a heuristic
        if (next.spellIndex !== routeState.spellIndex && equivalentNextBest) {
            // Has advanced
            if (!next.pendingResolves.length && (
                equivalentNextBest.currentValue() >= next.currentValue() && 
                equivalentNextBest.currentMagic >= next.currentMagic &&
                equivalentNextBest.di === next.di &&
                equivalentNextBest.diB === next.diB &&
                equivalentNextBest.cf === next.cf &&
                equivalentNextBest.ef === next.ef &&
                equivalentNextBest.refills >= next.refills
            )) {
                continue;
            }
        } else if (equivalentCurrentBest) {
            if (!next.pendingResolves.length && (
                equivalentCurrentBest.currentValue() >= next.currentValue() &&
                equivalentCurrentBest.currentMagic >= next.currentMagic &&
                equivalentCurrentBest.di === next.di &&
                equivalentCurrentBest.diB === next.diB &&
                equivalentCurrentBest.cf === next.cf &&
                equivalentCurrentBest.ef === next.ef &&
                equivalentCurrentBest.refills >= next.refills
            )) {
                continue;
            }
        }
        const max = next.currentMaxValue();
        if (bestState.currentValue() >= max) {
            continue;
        }

        /*if (isNoop(routeState, next)) {
            // resolve/refill can leave the state untouched; recursing on that would never terminate
            continue;
        }*/
        routeInfo.steps++;
        const result = (max === next.currentValue())?next:iterate(next, routeInfo, bestState);
        const value = result.currentValue();
        if (value > bestState.currentValue() || (value == bestState.currentValue() && result.currentMagic < bestState.currentMagic)) {
            bestState = result;
        }
        if (value > routeInfo.bestScore) {
            routeInfo.bestScore = value;
            routeInfo.bestCombo = { bs: result.bs, cf: result.cf, ef: result.ef, clot: result.clot };
        }
    }
    if (routeInfo.onProgress && performance.now() > routeInfo.nextReport) {
        routeInfo.nextReport = performance.now() + PROGRESS_INTERVAL;
        reportProgress(routeInfo);
    }
    return bestState;
}
export function isNoop(before: RouteState, after: RouteState) {
    return before.spellIndex === after.spellIndex
        && before.currentMagic === after.currentMagic
        && before.refills === after.refills
        && before.pendingResolves.length === after.pendingResolves.length
        && before.bs === after.bs
        && before.cf === after.cf
        && before.ef === after.ef;
}

export default route;