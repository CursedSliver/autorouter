import Spells from "./spelldata";

export const gfdRanges = (() => {
    const set: Set<number> = new Set();
    for (let i = 2; i <= 8; i++) {
        for (let ii = 0; ii < i; ii++) {
            set.add(ii / i);
        }
    }
    const bases: number[] = ([0.15, 0.15 * 1.1, 0.15 * 1.01, 0.15 * 1.11]).map(x => [x, x * 0.1, x * 5]).flat(Infinity) as number[];
    for (let i in bases) {
        for (let ii = 0; ii < 1; ii += 0.15) {
            const result = bases[i]! + ii;
            if (result < 1) {
                set.add(1 - result);
            }
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

const MAX_SIZE = 301;
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
export const TransmuteTable: number[][] = (() => {
    // encodes bitmask directly; PossibleGFDPools is for reference only; order is <none> - <si> - <rb> - <sirb> from highest digit to lowest digit
    let table: number[][] = new Array(MAX_SIZE).fill(undefined).map(() => new Array(MAX_SIZE));
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