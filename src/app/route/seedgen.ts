import type { Spell } from './route';
// Site for generating data consistent with base-game behavior.

//seeded random function, courtesy of http://davidbau.com/archives/2010/01/30/random_seeds_coded_hints_and_quintillions.html
const RNG = {
    random: () => 0,
    seedrandom: (seed: unknown): unknown => seed,
    pow: Math.pow
};
// `globalThis`, not `window`: the router runs the core inside a worker and the
// node test bundle loads it too, where `window` does not exist. On the page they
// are the same object, so the shim behaves identically.
// @ts-ignore
(function(a,b,c,d,e,f){function k(a){var b,c=a.length,e=this,f=0,g=e.i=e.j=0,h=e.S=[];for(c||(a=[c++]);d>f;)h[f]=f++;for(f=0;d>f;f++)h[f]=h[g=j&g+a[f%c]+(b=h[f])],h[g]=b;(e.g=function(a){for(var b,c=0,f=e.i,g=e.j,h=e.S;a--;)b=h[f=j&f+1],c=c*d+h[j&(h[f]=h[g=j&g+b])+(h[g]=b)];return e.i=f,e.j=g,c})(d)}function l(a,b){var e,c=[],d=(typeof a)[0];if(b&&"o"==d)for(e in a)try{c.push(l(a[e],b-1))}catch(f){}return c.length?c:"s"==d?a:a+"\0"}function m(a,b){for(var d,c=a+"",e=0;c.length>e;)b[j&e]=j&(d^=19*b[j&e])+c.charCodeAt(e++);return o(b)}function n(c){try{return a.crypto.getRandomValues(c=new Uint8Array(d)),o(c)}catch(e){return[+new Date,a,a.navigator.plugins,a.screen,o(b)]}}function o(a){return String.fromCharCode.apply(0,a)}var g=c.pow(d,e),h=c.pow(2,f),i=2*h,j=d-1;c.seedrandom=function(a,f){var j=[],p=m(l(f?[a,o(b)]:0 in arguments?a:n(),3),j),q=new k(j);return m(o(q.S),b),c.random=function(){for(var a=q.g(e),b=g,c=0;h>a;)a=(a+c)*d,b*=d,c=q.g(1);for(;a>=i;)a/=2,b/=2,c>>>=1;return(a+c)/b},p},m(c.random(),b)})(globalThis,[],RNG,256,6,52);

export type Buff = 'frenzy' | 'multiply cookies' | 'click frenzy' | 'cookie storm' | 'building special' | 'cookie storm drop' | 'free sugar lump' | 'clot' | 'ruin cookies' | 'cursed finger' | 'blood frenzy' | 'blab'
export const Fthof = {
    // Modified base-game function
    win: (seed: string, castCount: number, offset: boolean, df: boolean): Buff => {
        RNG.seedrandom(seed + '/' + castCount);
        RNG.random(); RNG.random(); RNG.random();
        if (offset) RNG.random();
        let choices = [];
        choices.push('frenzy', 'multiply cookies');
        if (!df) choices.push('click frenzy');
        if (RNG.random() < 0.1) choices.push('cookie storm', 'cookie storm', 'blab');
        if (RNG.random() < 0.25) choices.push('building special');
        if (RNG.random() < 0.15) choices = ['cookie storm drop'];
        if (RNG.random() < 0.0001) choices.push('free sugar lump');
        return choices[Math.floor(RNG.random() * choices.length)] as Buff;
    },
    lose: (seed: string, castCount: number, offset: boolean): Buff => {
        RNG.seedrandom(seed + '/' + castCount);
        RNG.random(); RNG.random(); RNG.random();
        if (offset) RNG.random();
        var choices = [];
        choices.push('clot', 'ruin cookies');
        if (RNG.random() < 0.1) choices.push('cursed finger', 'blood frenzy');
        if (RNG.random() < 0.003) choices.push('free sugar lump');
        if (RNG.random() < 0.1) choices = ['blab'];
        return choices[Math.floor(RNG.random() * choices.length)] as Buff;
    },
    rs: (seed: string, castCount: number): number => {
        RNG.seedrandom(seed + '/' + castCount);
        return RNG.random();
    }
}
export const ProperBuffNames: Record<Buff, string> = {
    'frenzy': 'Frenzy',
    'multiply cookies': 'Lucky',
    'click frenzy': 'Click Frenzy',
    'cookie storm': 'Cookie Storm',
    'building special': 'Building Special',
    'cookie storm drop': 'Cookie Storm Drop',
    'free sugar lump': 'Free Sugar Lump',
    'clot': 'Clot',
    'ruin cookies': 'Ruin',
    'cursed finger': 'Cursed Finger',
    'blood frenzy': 'Elder Frenzy',
    'blab': 'Blab'
};
export const ProperBuffShorthands: Record<Buff, string> = {
    'frenzy': 'F',
    'multiply cookies': 'L',
    'click frenzy': 'CF',
    'cookie storm': 'CS',
    'building special': 'BS',
    'cookie storm drop': 'CSD',
    'free sugar lump': 'Lump',
    'clot': 'C',
    'ruin cookies': 'R',
    'cursed finger': 'CF',
    'blood frenzy': 'EF',
    'blab': 'B'
};
export const EmphasizedBuffs: Set<Buff> = new Set(['building special', 'click frenzy', 'blood frenzy', 'free sugar lump']);

// Format the row elsewhere for stuff like g!spell results and backfires
export interface RawPlannerRow {
    noChangeSuccess: Buff;
    noChangeDFSuccess: Buff;
    noChangeBackfire: Buff;
    changeSuccess: Buff;
    changeDFSuccess: Buff;
    changeBackfire: Buff;
    gfdRs: number;
}
export function generatePlannerData(seed: string, start: number, endExclusive: number): RawPlannerRow[] {
    let results: RawPlannerRow[] = [];
    for (let i = start; i < endExclusive; i++) {
        results.push({
            noChangeSuccess: Fthof.win(seed, i, false, false),
            noChangeDFSuccess: Fthof.win(seed, i, false, true),
            noChangeBackfire: Fthof.lose(seed, i, false),
            changeSuccess: Fthof.win(seed, i, true, false),
            changeDFSuccess: Fthof.win(seed, i, true, true),
            changeBackfire: Fthof.lose(seed, i, true),
            gfdRs: Fthof.rs(seed, i)
        });
    }
    return results;
}
// test
(globalThis as unknown as { generatePlannerData?: typeof generatePlannerData }).generatePlannerData =
    generatePlannerData;
export function purifyPlannerData(data: RawPlannerRow[]): Spell[] {
    return data.map(row => ({
        bs: row.noChangeSuccess === 'building special' || row.changeSuccess === 'building special',
        dfBs: row.noChangeDFSuccess === 'building special' || row.changeDFSuccess === 'building special',
        cf: row.noChangeSuccess === 'click frenzy' || row.changeSuccess === 'click frenzy',
        ef: row.noChangeBackfire === 'blood frenzy' || row.changeBackfire === 'blood frenzy',
        gfdRs: row.gfdRs
    }));
}
function b64_to_utf8(str: string) {
	try{return decodeURIComponent(Array.prototype.map.call(atob(str), function(c) {
		return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2)
	}).join(''));}
	catch(err)
	{return '';}
}
function isValidSaveOrSeed(save: string) {
    if (!save) { return false; }
    if (save.length === 5 && save.match(/[a-z]?/)) {
      return true; // Is a seed
    }
    const main = b64_to_utf8(unescape(save).split('!END!')[0]!);
    const list = main.split('|');
    if (list.length < 3) { return false; }
    const spl = list[2]!.split(';');
    if (spl.length < 5) { return false; }
    return spl[4] && spl[4].length === 5 && spl[4].match(/[a-z]?/);
}
export interface SaveOutput {
    seed: string;
    spellsCastTotal: number;
}
export function extractSeedFromSave(save: string, forceCastCount?: number): SaveOutput {
    // Pulled this from the planner
    if (!isValidSaveOrSeed(save)) {
        // try catch this
        throw new Error('Invalid save or seed!');
    }
    if (save.length === 5) {
        return {
            seed: save,
            spellsCastTotal: forceCastCount ?? 0
        }
    }
    let output: SaveOutput = {
        seed: '',
        spellsCastTotal: 0
    };
    var str = unescape(save.trim()).split('!END!')[0] as string;
    str = b64_to_utf8(str);
    let arr = str.split('|');
    var spl = arr[2]!.split(';');
    output.seed = spl[4]!;

    if (forceCastCount != null) {
        output.spellsCastTotal = forceCastCount;
        return output;
    }

    spl = arr[5]!.split(';');

    output.spellsCastTotal = parseInt(spl[7]!.split(' ')[2]!) || 0;

    return output;
}
export function towerCountToMaxMagic(towers: number, lvl: number): number {
    return Math.floor(4+Math.pow(towers,0.6)+Math.log((towers+(lvl-1)*10)/15+1)*15);
}
export function maxMagicToTowerCount(magic: number, lvl: number): [number, number] {
    // return in format [min, max)
    magic = Math.ceil(magic);
    let tower = 1;
    let minTower = -Infinity;
    while(tower <= 4939) {
        if (towerCountToMaxMagic(tower, lvl) >= magic && minTower < 0) {
            minTower = tower;
        }
        if (minTower >= 0 && towerCountToMaxMagic(tower, lvl) > towerCountToMaxMagic(minTower, lvl)) {
            return [minTower, tower];
        }
        tower++;
    }
    return [4940, Infinity];
}