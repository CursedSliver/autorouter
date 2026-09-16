interface SpellData {
    name: string;
    baseCost: number;
    portionCost: number;
    index: number;
}
enum SpellIDs {
    'conjure baked goods' = 'conjure baked goods',
    'hand of fate' = 'hand of fate',
    'stretch time' = 'stretch time',
    'spontaneous edifice' = 'spontaneous edifice',
    'haggler charm' = 'haggler charm',
    'summon crafty pixies' = 'summon crafty pixies',
    'resurrect abomination' = 'resurrect abomination',
    'diminish ineptitude' = 'diminish ineptitude'
}
const Spells: Record<SpellIDs, SpellData> = {
    'conjure baked goods': {
        name: 'Conjure Baked Goods',
        baseCost: 2,
        portionCost: 0.4,
        index: 0
    },
    'hand of fate': {
        name: 'Force the Hand of Fate',
        baseCost: 10,
        portionCost: 0.6,
        index: 1
    },
    'stretch time': {
        name: 'Stretch Time',
        baseCost: 8,
        portionCost: 0.2,
        index: 2
    },
    'spontaneous edifice': {
        name: 'Spontaneous Edifice',
        baseCost: 20,
        portionCost: 0.75,
        index: 3
    },
    'haggler charm': {
        name: 'Haggler\'s Charm',
        baseCost: 10,
        portionCost: 0.1,
        index: 4
    },
    'summon crafty pixies': {
        name: 'Summon Crafty Pixies',
        baseCost: 10,
        portionCost: 0.2,
        index: 5
    },
    'resurrect abomination': {
        name: 'Resurrect Abomination',
        baseCost: 20,
        portionCost: 0.1,
        index: 6
    },
    'diminish ineptitude': {
        name: 'Diminish Ineptitude',
        baseCost: 5,
        portionCost: 0.2,
        index: 7
    }
}
export default Spells;