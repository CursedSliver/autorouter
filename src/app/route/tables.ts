import Spells from "./spelldata";
type spellIds = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const gfdOnlyRanges: number[] = (() => {
    const set: Set<number> = new Set();
    for (let i = 2; i <= 8; i++) {
        for (let ii = 0; ii < i; ii++) {
            set.add(ii / i);
        }
    }
    const result = Array.from(set).sort((a, b) => a - b).filter(x => x < 1);
    // Filter all ranges less than 5 * EPSILON to eliminte floating point errors
    for (let i = 0; i < result.length; i++) {
        if (i === 0) { continue; }
        if (result[i]! - result[i - 1]! < 5 * Number.EPSILON) {
            result.splice(i - 1, 1);
            i--;
        }
    }
    return result;
})();
const amplifyFactor = 8 * 3 * 5 * 7;
const AmplifiedRSToRange: number[] = (() => {
    const amplifiedRanges = gfdOnlyRanges.map(n => Math.round(n * amplifyFactor));
    let arr = new Array(amplifyFactor).fill(undefined);
    for (let i = 0; i < amplifyFactor; i++) {
        for (let ii = 0; ii < amplifiedRanges.length; ii++) {
            if (i >= amplifiedRanges[ii]!) {
                arr[i] = ii;
            }
        }
    }
    return arr;
})();
export function getRangeFromRS(rs: number) {
    return AmplifiedRSToRange[Math.floor(rs * amplifyFactor)];
}

const MAX_SIZE = 384;
export const PossibleGFDPools: number[] = (() => {
    const pools: Set<number> = new Set(); // Number encoding: 8 bits, each bit representing whether the spell is in the pool
    const spells = Object.values(Spells).sort((a, b) => a.index - b.index);
    for (const mult of [1, 0.9, 0.99, 0.89]) {
        for (let max = 0; max < MAX_SIZE; max++) {
            const gfd = Math.floor(mult * (3 + 0.05 * max));
            for (let cur = 0; cur < MAX_SIZE; cur++) {
                let n = 0;
                for (let spell of spells) {
                    if (cur >= Math.floor(mult * (spell.baseCost + spell.portionCost * max)) / 2 + gfd) {
                        n += 1 << spell.index;
                    }
                }
                pools.add(n);
            }
        }
    }
    return Array.from(pools);
})(); // encodes indices 
export const CostTable: Record<keyof typeof Spells, [number, number, number, number][]> = (() => {
    let tables: Record<string, [number, number, number, number][]> = {

    };
    for (let id in Spells) {
        tables[id as keyof typeof Spells] = [];
        const spell = Spells[id as keyof typeof Spells];
        for (let max = 0; max < MAX_SIZE; max++) {
            tables[id as keyof typeof Spells]!.push([
                Math.floor(spell.baseCost + spell.portionCost * max),
                Math.floor(0.9 * (spell.baseCost + spell.portionCost * max)),
                Math.floor(0.99 * (spell.baseCost + spell.portionCost * max)),
                Math.floor(0.89 * (spell.baseCost + spell.portionCost * max))
            ]);
        }
    }
    return tables;
})();
export function safeAccessCostTable(spell: keyof typeof Spells, max: number, subIndex: 0 | 1 | 2 | 3) {
    if (max >= MAX_SIZE) {
        // Alternate pathway that computes the cost directly
        return Math.floor(([1, 0.9, 0.99, 0.89][subIndex]!) * (Spells[spell].baseCost + Spells[spell].portionCost * max));
    }
    return CostTable[spell][max]![subIndex];
}
export const TransmuteTable: Uint32Array[] = (() => {
    // encodes bitmask directly; PossibleGFDPools is for reference only; order is <none> - <si> - <rb> - <sirb> from highest digit to lowest digit
    // note: the spell list is reversed
    let table: Uint32Array[] = new Array(MAX_SIZE).fill(undefined).map(() => new Uint32Array(MAX_SIZE));
    const spells = Object.values(Spells).sort((a, b) => a.index - b.index);
    const multList = [1, 0.9, 0.99, 0.89];
    for (let cur = 0; cur < MAX_SIZE; cur++) {
        for (let max = 0; max < MAX_SIZE; max++) {
            let n = 0; 
            for (let multI = 0; multI < 4; multI++) {
                const gfd = Math.floor(multList[multI]! * (3 + 0.05 * max));
                for (let spell of spells) {
                    if (cur >= Math.floor(multList[multI]! * (spell.baseCost + spell.portionCost * max)) / 2 + gfd) {
                        n += 2 ** (8 * (3 - multI) + spell.index);
                    }
                }  
            }
            table[cur]![max] = n;
        }
    }
    return table;
})(); // first layer is cur, second layer is max
export const PoolPopCountCached: Record<number, number> = (() => {
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
function ableToTransmuteWith(gfdRs: number, pool: number, spellId: spellIds) {
    let n = 0;
    if (PoolPopCountCached[pool]! === 0) {
        return false;
    }
    const count = Math.floor(gfdRs * PoolPopCountCached[pool]!);
    for (let m = 0; m < 8; m++) {
        if (pool & (1 << m) && n++ === count) {
            //return (7 - m) === spellId;
            return m === spellId;
        }
    }
    return false;
}
export const RangedTransmuteGuides: Record<number, Record<spellIds, Uint8Array[]>> = (() => {
    // Records how to reach a certain transmute by leveraging the fact that transmute targets come in large continuous chunks. 
    // Actuality: Record<gfdRange (indexed from gfdRanges), Record<spellId, [cur][max]> = 0000<none><si><rb><sirb>
    let table: Record<number, Record<spellIds, Uint8Array[]>> = {};
    // 256 max magic is unreachable with a tower level less than 19, so just bound the tower level to 18 or smth its fine 
    const TRUE_METAMAX = 256;
    for (let range = 0; range < gfdOnlyRanges.length; range++) {
        table[range] = {} as Record<spellIds, Uint8Array[]>;
        const rangeVal = gfdOnlyRanges[range]! + 4 * Number.EPSILON;
        for (let id = 0; id < 8; id++) {
            const data: Array<Uint8Array> = new Array(MAX_SIZE).fill(undefined);
            for (let cur = 0; cur < MAX_SIZE; cur++) {
                const arr = data[cur] = new Uint8Array(TRUE_METAMAX);
                for (let max = 0; max < TRUE_METAMAX; max++) {
                    const entry = TransmuteTable[cur]![max]!;
                    for (let i = 0; i < 4; i++) {
                        if (ableToTransmuteWith(rangeVal, (entry >>> (i * 8)) & 255, id as spellIds)) {
                            arr[max]! += 1 << i;
                        }
                    }
                }
            }
            table[range]![id as spellIds] = data;
        }
    }
    return table;
})();