import type { Spell } from "./route";


// Routes a combo with some assumptions to establish an upper bound on the gains from every cast count
// Assumptions made: infinite magic, arbitrary transmutes (if possible)
// Replaces initializeValueEvaluationList in route.ts
// Note: add restrictions later ig.
export enum PossibleEvaluations {
    // <existing buffs> - <which kinds of onscreens to keep>
    '-' = '-',
    '-cf' = '-cf',
    '-ef' = '-ef',
    '-cfef' = '-cfef',
    'cf-' = 'cf-',
    'cf-cf' = 'cf-cf',
    'cf-ef' = 'cf-ef',
    'cf-cfef' = 'cf-cfef',
    'ef-' = 'ef-',
    'ef-cf' = 'ef-cf',
    'ef-ef' = 'ef-ef',
    'ef-cfef' = 'ef-cfef',
    'cfef-' = 'cfef-',
    'cfef-cf' = 'cfef-cf',
    'cfef-ef' = 'cfef-ef',
    'cfef-cfef' = 'cfef-cfef'
}
export interface SimpleAction {
    name: string;
    invoke: (state: RouteBoundState) => void;
    able: (state: RouteBoundState) => boolean;
}
export const SimpleActions: SimpleAction[] = [
    {
        name: 'fthof-bs',
        invoke: state => { 
            state.score += state.bsScore; 
            state.increment(); 
        },
        able: state => !!(state.peek() && state.peek()!.bs && state.possibleToSucceed(state.peek()!.gfdRs))
    },
    {
        name: 'fthof-cf',
        invoke: state => { 
            state.score += state.cfScore; 
            state.cfScore = 0; 
            if (state.toKeep.includes('cf')) {
                state.minOnscreens++;
            }
            state.increment(); 
        },
        able: state => !!(state.peek() && state.peek()!.cf && state.cfScore && state.possibleToSucceed(state.peek()!.gfdRs))
    },
    {
        name: 'fthof-ef',
        invoke: state => { 
            state.score += state.efScore; 
            state.efScore = 0; 
            if (state.toKeep.includes('ef')) {
                state.minOnscreens++;
            }
            state.increment(); 
        },
        able: state => !!(state.peek() && state.peek()!.ef && state.efScore)
    },
    {
        name: 'g!fthof',
        invoke: state => {
            state.addPendingResolve();
            state.increment();
        },
        able: state => !!(state.peek() && state.peek()!.gfdRs < 1 / 3 && state.peek()!.gfdRs >= 0.125)
    },
    {
        name: 'resolve-bs',
        invoke: state => {
            state.score += state.bsScore;
            state.gfthofs--;
        },
        able: state => {
            const spell = state.peek();
            return !!(spell && state.gfthofs > 0 && (spell.bs && spell.gfdRs < 0.5));
        }
    },
    {
        name: 'resolve-cf',
        invoke: state => {
            state.score += state.cfScore; 
            state.cfScore = 0; 
            if (state.toKeep.includes('cf')) {
                state.minOnscreens++;
            }
            state.gfthofs--;
        },
        able: state => {
            const spell = state.peek();
            return !!(spell && state.gfthofs > 0 && (spell.cf && spell.gfdRs < 0.5) && state.cfScore);
        }
    },
    {
        name: 'resolve-ef',
        invoke: state => {
            state.score += state.efScore; 
            state.efScore = 0; 
            if (state.toKeep.includes('ef')) {
                state.minOnscreens++;
            }
            state.gfthofs--;
        },
        able: state => {
            const spell = state.peek();
            return !!(spell && state.gfthofs > 0 && spell.ef && state.efScore);
        }
    },
    {
        name: 'skip',
        invoke: state => state.increment(),
        able: state => !!state.peek()
    }
];
export class RouteBoundState {
    parent: RouteBoundState | null = null;
    score: number = 0;
    bsScore: number;
    cfScore: number;
    efScore: number;
    minOnscreens: number;
    toKeep: '' | 'cf' | 'ef' | 'cfef';
    constructor(public spells: Spell[], public row: number, public gfthofs: number, type?: PossibleEvaluations) {
        this.bsScore = 1;
        this.cfScore = 1.4;
        this.efScore = 1.3;
        this.minOnscreens = 0;
        if (!type) {
            this.toKeep = '';
            return;
        }
        const [existing, toKeep] = type.toString().split('-');
        if (existing?.includes('cf')) {
            this.cfScore = 0;
            if (toKeep?.includes('cf')) {
                this.minOnscreens++;
            }
        }
        if (existing?.includes('ef')) {
            this.efScore = 0;
            if (toKeep?.includes('ef')) {
                this.minOnscreens++;
            }
        }
        this.toKeep = toKeep! as '' | 'cf' | 'ef' | 'cfef';
        this.spells = this.purifySpells();
    }
    purifySpells() {
        return this.spells.map(spell => ({
            bs: this.possibleToSucceed(spell.gfdRs) && spell.bs,
            dfBs: this.possibleToSucceed(spell.gfdRs) && spell.dfBs,
            cf: !!this.cfScore && this.possibleToSucceed(spell.gfdRs) && spell.cf,
            ef: !!this.efScore && spell.ef,
            gfdRs: spell.gfdRs
        }));
    }
    ended() {
        return this.row >= this.spells.length;
    }
    peek() {
        return this.spells[this.row];
    }
    increment() {
        return this.spells[this.row++];
    }
    possibleToSucceed(gfdrs: number) {
        return gfdrs <= (1 - 0.015 - 0.15 * this.minOnscreens);
    }
    addPendingResolve() {
        this.gfthofs++;
    }
    indexedParentLatest(spellIndex: number): RouteBoundState | null {
        let pointer: RouteBoundState = this;
        while(pointer.parent) {
            if (pointer.row === spellIndex) {
                return pointer;
            }
            pointer = pointer.parent;
        }
        return null;
    }
    extendedCurrentScore() {
        // How much score you can have if you resolved everything rn
        let gfthofs = this.gfthofs;
        return this.score + (this.cfScore && gfthofs > 0 ? (this.cfScore + 0 * (gfthofs--)) : 0)
            + (this.efScore && gfthofs > 0 ? (this.efScore + 0 * (gfthofs--)) : 0)
            + (this.bsScore * gfthofs);
    }
    duplicate() {
        const copy = new RouteBoundState(this.spells, this.row, this.gfthofs);
        copy.score = this.score;
        copy.bsScore = this.bsScore;
        copy.cfScore = this.cfScore;
        copy.efScore = this.efScore;
        copy.minOnscreens = this.minOnscreens;
        copy.toKeep = this.toKeep;
        copy.parent = this;
        return copy;
    }
}
function routeBounds(spells: Spell[]): Record<PossibleEvaluations, number>[][] {
    // Output format ...[row][cachedGfthofsCount (calculated based on maximum amount of gfthofs at this time)][BuffAffectedEvaluationRow0]
    let output = new Array(spells.length).fill(undefined);
    for (let row = 0; row < spells.length; row++) {
        const count = row === 0 ? 0 : getGfthofsCount(spells, 0, row);
        let currentRow = [];
        for (let gfthofs = 0; gfthofs <= count; gfthofs++) {
            let results: Record<PossibleEvaluations, number> = {} as Record<PossibleEvaluations, number>;
            for (let existing of ['', 'cf', 'ef', 'cfef']) {
                for (let toKeep of ['', 'cf', 'ef', 'cfef']) {
                    const type = existing + '-' + toKeep as PossibleEvaluations;
                    results[type] = 
                        iterate(new RouteBoundState(spells, row, gfthofs, type),
                            new RouteBoundState(spells, row, gfthofs, type)).score;
                }
            }
            currentRow.push(results);
        }
        output[row] = currentRow;
    }
    return output;
}
function iterate(state: RouteBoundState, best: RouteBoundState): RouteBoundState {
    if (state.ended()) {
        return state;
    }
    // If we are on the same index after an action
    let equivalentCurrentBest = best.indexedParentLatest(state.row - 1); 
    // If we are on the next index after an action
    let equivalentNextBest = best.indexedParentLatest(state.row);
    for (const action of SimpleActions) {
        if (!action.able(state)) {
            continue;
        }
        const next = state.duplicate();
        action.invoke(next);
        // Note: heuristics loses with toKeep = nonempty
        if (next.row !== state.row) {
            if (equivalentNextBest && next.extendedCurrentScore() <= equivalentNextBest.score) {
                continue;
            }
        } else if (equivalentCurrentBest) {
            if (next.extendedCurrentScore() <= equivalentCurrentBest.score) {
                continue;
            }
        }
        const result = iterate(next, best);
        if (result.score > best.score) {
            best = result;
        }
    }
    return best;
}
function getGfthofsCount(spells: Spell[], startRow: number, endRowExclusive: number) {
    let count = 0;
    if (startRow >= spells.length || endRowExclusive <= startRow) {
        throw new Error('Malformed inputs');
    } 
    for (let row = startRow; row < endRowExclusive; row++) {
        // g!fthof only possible within these ranges as other ranges are 
        // gated by the fact that g!fthof is almost always the second spell to disappear as max magic increases
        if (spells[row]!.gfdRs < 1 / 3 && spells[row]!.gfdRs >= 0.125) {
            count++;
        }
    }
    return count;
}
export default routeBounds;