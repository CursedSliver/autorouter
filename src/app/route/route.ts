import { TransmuteTable } from "./tables";

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
export interface Action {
    name: string; // in generated actions the name contains the parameters separated by the dash
    invoke: (state: RouteState) => unknown;
    able: (state: RouteState) => boolean;
    gfdCost?: (state: RouteState) => number;
}
export const Actions: Action[] = [
    {
        name: 'fthof',
        invoke: state => { 
            // the cast consumes the entry it is cast on, so the effect must be read before it is consumed
            const spell = state.peek();
            const backfires = state.backfires(1.11); // For now assume that all gcs will be clicked immediately after casting
            if (!spell) { return; }
            state.castSpell(10, 0.6); 
            if (spell.ef && backfires && !state.ef) {
                state.addBuff('ef');
            } else if (spell.cf && !backfires && !state.cf) {
                state.addBuff('cf');
            } else if (spell.bs && !backfires) {
                state.addBuff('bs');
            }
        },
        gfdCost: state => state.getCost(10, 0.6),
        able: state => state.currentMagic >= state.getCost(10, 0.6)
    },
    {
        name: 'hc',
        invoke: state => state.castSpell(10, 0.1),
        gfdCost: state => state.getCost(10, 0.1),
        able: state => state.currentMagic >= state.getCost(10, 0.1)
    }, 
    {
        name: 'di',
        invoke: state => { 
            const backfires = state.backfires(1.11);
            state.castSpell(5, 0.2);
            if (!backfires) {
                state.addBuff('di');
            } else {
                state.addBuff('diB');
            }
        },
        gfdCost: state => state.getCost(5, 0.2),
        able: state => state.currentMagic >= state.getCost(5, 0.2)
    },
    {
        name: 'cbg',
        invoke: state => { 
            if (state.backfires(1.11)) {
                state.addBuff('clot');
            }
            state.castSpell(2, 0.4);
        },
        gfdCost: state => state.getCost(2, 0.4),
        able: state => state.currentMagic >= state.getCost(2, 0.4)
    },
    {
        name: 'st',
        invoke: state => state.castSpell(8, 0.2),
        gfdCost: state => state.getCost(8, 0.2),
        able: state => state.currentMagic >= state.getCost(8, 0.2)
    },
    {
        name: 'scp',
        invoke: state => state.castSpell(10, 0.2),
        gfdCost: state => state.getCost(10, 0.2),
        able: state => state.currentMagic >= state.getCost(10, 0.2)
    },
    {
        name: 'refill',
        invoke: state => state.refill(),
        // at exactly metamax a refill spends a charge for no magic, which is strictly dominated
        able: state => state.refills > 0 && state.currentMagic !== state.metamax
    },
    {
        name: 'resolve',
        invoke: state => state.resolve(),
        able: state => !!state.pendingResolves.length
    },
    // Note: metamax max 200
    {
        name: 'g!fthof',
        invoke: state => tryCastGFDTo(1, state, 10, 0.6),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!ra',
        invoke: state => tryCastGFDTo(6, state, 20, 0.1),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!se',
        invoke: state => tryCastGFDTo(3, state, 20, 0.75),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!hc',
        invoke: state => tryCastGFDTo(4, state, 10, 0.1),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!di',
        invoke: state => tryCastGFDTo(7, state, 5, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!st',
        invoke: state => tryCastGFDTo(2, state, 8, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!cbg',
        invoke: state => tryCastGFDTo(0, state, 2, 0.4),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    },
    {
        name: 'g!scp',
        invoke: state => tryCastGFDTo(5, state, 10, 0.2),
        able: state => state.currentMagic >= state.getCost(3, 0.05, 1)
    }
];
//const SpellActions = Actions.filter(act => act.gfdCost);
const PoolPopCountCached: Record<number, number> = (() => {
    function popcount(n: number) {
        let count = 0;
        while (n) {
            n &= n - 1; 
            count++;
        }
        return count;
    }
    const result: Record<number, number> = {};
    for (let i = 0; i < 256; i++) {
        result[i] = popcount(i);
    }
    return result;
})();
function gfdGetsSpell(pool: number, gfdRs: number) {
    let n = 0;
    const count = Math.floor(gfdRs * PoolPopCountCached[pool]!);
    if (count === 0) {
        return -1;
    }
    for (let m = 7; m >= 0; m--) {
        if (pool & (1 << m) && n++ === count) {
            return (7 - m);
        }
    }
    return -1;
}
function tryCastGFDTo(spellIndex: SpellIndices, state: RouteState, baseCost: number, portionCost: number) {
    const spell = state.peek();
    if (!spell) { return; }
    const row = TransmuteTable[state.currentMagic];
    if (!row) { return Symbol.for('Cancel action'); }
    for (let i = state.currentMagic; i <= state.metamax; i++) {
        const s = gfdGetsSpell(row[i]! & 255, spell.gfdRs);
        if (s === spellIndex) {  
            state.addResolve(state.castSpell(3, 0.05, i), 
                Math.floor(0.89 * (baseCost + portionCost * i)) / 2, 
                spellIndex);
            return Symbol.for('Successful action'); 
        }
    }
    return Symbol.for('Cancel action');
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
export class RouteState {
    constructor(public parent: RouteState | null, public spells: Spell[], public currentMagic: number, public spellIndex: number, public metamax: number, public refills: 0 | 1 | 2) {

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
    backfires(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs > (1 - 0.15 * mult * (this.di ? 0.1 : 1) * (this.diB ? 5 : 1));
    }
    backfiresGFD(mult: number) {
        const spell = this.peek();
        if (!spell) {
            return false;
        }
        return spell.gfdRs > Math.min(1 - 0.15 * mult * (this.di ? 0.1 : 1) * (this.diB ? 5 : 1), 0.5);
    }
    getCost(base: number, portion: number, max?: number) {
        return Math.floor(0.89 * (base + portion * (max ?? this.currentMagic)));
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
        
        if (gfd.spell === SpellIndices.RA || (gfd.spell === SpellIndices.SE && !this.backfiresGFD(1.1))) { 
            this.currentMagic += gfd.gfdCost;            
        } else if (this.currentMagic >= gfd.chainCost) { 
            this.currentMagic -= gfd.chainCost; 
            if (gfd.spell === SpellIndices.FTHOF) {
                const spell = this.peek();
                if (!spell) {
                    return false;
                }
                const backfires = this.backfiresGFD(1.11);
                if (spell.ef && backfires && !this.ef) {
                    this.addBuff('ef');
                } else if (spell.cf && !backfires && !this.cf) {
                    this.addBuff('cf');
                } else if (spell.bs && !backfires) {
                    this.addBuff('bs');
                }
            } else if (gfd.spell === SpellIndices.DI) {
                const backfires = this.backfiresGFD(1.11);
                if (!backfires) {
                    this.addBuff('di');
                } else {
                    this.addBuff('diB');
                }
            } else if (gfd.spell === SpellIndices.CBG) {
                if (this.backfiresGFD(1.11)) {
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
    }
    currentValue() {
        return this.bs + (this.cf?1.5:0) + (this.ef?1.5:0) - (this.clot?0.1:0);
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
        const n = new RouteState(this, this.spells, this.currentMagic, this.spellIndex, this.metamax, this.refills);
        n.bs = this.bs;
        n.cf = this.cf;
        n.ef = this.ef;
        n.di = this.di;
        n.diB = this.diB;
        n.clot = this.clot;
        n.pendingResolves = this.pendingResolves.length > 0 ? this.pendingResolves.map(gfd => ({ ...gfd })) : [];
        return n;
    }
}
interface RouteInfo {
    goal: number;
    /** Branches expanded so far, and the count at which the next report is due. */
    steps: number;
    nextReport: number;
    /** Cheap estimate of the total step count, used to turn `steps` into progress. */
    estimate: number;
    /** Best score of any state the search has reached; the value a halt would report. */
    bestScore: number;
    onProgress: ((progress: RouteProgress) => void) | null;
}
/** Steps between progress reports: one report costs a division, a message and a DOM write. */
const PROGRESS_INTERVAL = 1 << 19;
interface RouteInput {
    spells: Spell[],
    goal: number,
    metamax: number,
    /** Explicit truncation budget. When omitted the search runs to completion. */
    stepLimit?: number,
    currentMagic: number,
    startingRefills: 0 | 1 | 2,
    index?: number,
    /** Called every `PROGRESS_INTERVAL` steps with a cheap progress estimate. */
    onProgress?: (progress: RouteProgress) => void
}
/** Cheap sample of a running search. `score` is reachable but not necessarily optimal. */
export interface RouteProgress {
    /** Branches expanded so far. */
    steps: number;
    /** Estimated share of the search that is done, in [0, 1); 1 only once `route()` returns. */
    progress: number;
    /** Best score reached so far - what stopping the search right now would report. */
    score: number;
}
function route(info: RouteInput) {
    const root = new RouteState(null, info.spells, info.currentMagic, info.index ?? 0, info.metamax, info.startingRefills);
    const routeInfo: RouteInfo = { 
        goal: info.goal, 
        steps: 0,
        nextReport: PROGRESS_INTERVAL,
        estimate: estimateTotalSteps(root, info.spells.length, info.startingRefills, info.stepLimit),
        bestScore: 0,
        onProgress: info.onProgress ?? null
    };
    const best = iterate(
        root, 
        routeInfo, 
        new RouteState(null, [], 0, 0, info.metamax, 0)
    );
    reportProgress(routeInfo, 1);
    return best;
}

function estimateTotalSteps(root: RouteState, rows: number, refills: number, stepLimit?: number) {
    if (stepLimit !== undefined) { return Math.max(stepLimit, 1); }
    let branching = 0;
    for (const action of Actions) {
        if (!action.able(root)) { continue; }
        const probe = root.duplicate();
        if (probe.act(action) && !isNoop(root, probe)) { branching++; }
    }
    return (Math.max(branching, 1) * (1 + 0.35 * refills)) ** Math.max(rows, 1);
}

function progressEstimate(steps: number, estimate: number) {
    if (steps <= estimate) { return 0.9 * (steps / estimate); }
    return 0.9 + 0.09 * (1 - Math.exp(-(steps - estimate) / estimate));
}
function reportProgress(routeInfo: RouteInfo, progress: number) {
    if (!routeInfo.onProgress) { return; }
    routeInfo.onProgress({ steps: routeInfo.steps, progress, score: routeInfo.bestScore });
}
function iterate(routeState: RouteState, routeInfo: RouteInfo, bestScore: RouteState) {
    if (routeState.ended()) {
        return routeState;
    }
    let bestState: RouteState = routeState;
    // If we are on the same index after an action
    let equivalentCurrentBest = bestScore.indexedParentLatest(routeState.spellIndex - 1); 
    // If we are on the next index after an action
    let equivalentNextBest = bestScore.indexedParentLatest(routeState.spellIndex);
    for (let act of Actions) {
        if (!act.able(routeState)) {
            continue;
        }
        const next = routeState.duplicate();
        if (!next.act(act)) { 
            continue;
        }
        // Yes, this is a heuristic
        if (next.spellIndex !== routeState.spellIndex) {
            // Has advanced
            if (equivalentNextBest && !next.pendingResolves.length && (
                equivalentNextBest.currentValue() >= next.currentValue() && 
                equivalentNextBest.currentMagic >= next.currentMagic
            )) {
                continue;
            }
        } else {
            if (equivalentCurrentBest && !next.pendingResolves.length && (
                equivalentCurrentBest.currentValue() >= next.currentValue() &&
                equivalentCurrentBest.currentMagic >= next.currentMagic
            )) {
                continue;
            }
        }

        if (isNoop(routeState, next)) {
            // resolve/refill can leave the state untouched; recursing on that would never terminate
            continue;
        }
        routeInfo.steps++;
        const result = iterate(next, routeInfo, bestState);
        const value = result.currentValue();
        if (value > bestState.currentValue() || (value == bestState.currentValue() && result.currentMagic < bestState.currentMagic)) {
            bestState = result;
        }
        if (value > routeInfo.bestScore) {
            // Every visited state is reachable, so the running maximum is a score
            // the search could report: that is what a halt mid-search would show.
            routeInfo.bestScore = value;
        }
    }
    if (routeInfo.onProgress && routeInfo.steps >= routeInfo.nextReport) {
        routeInfo.nextReport = routeInfo.steps + PROGRESS_INTERVAL;
        reportProgress(routeInfo, progressEstimate(routeInfo.steps, routeInfo.estimate));
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