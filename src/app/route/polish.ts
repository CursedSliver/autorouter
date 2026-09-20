// Based on raw spell data and route complete the actual route with exact instructions formatted in a human readable way

import type { Action, RouteState } from "./route";
import { Actions } from './route';
import { towerCountToMaxMagic } from './seedgen';
import type { Buff, RawPlannerRow } from './seedgen';

const MAX_TOWER_COUNT = 4939;
const SPRITE_CELL = 48;
const ICON_SIZE = Math.round(SPRITE_CELL * 0.7);

interface SeasonSwitch {
    text: string;
    raw: string;
    icon: [number, number, string];
    color: string;
}
const FtHofBuffTargets: Record<string, { buff: Buff; backfire: boolean }> = {
    cf: { buff: 'click frenzy', backfire: false },
    bs: { buff: 'building special', backfire: false },
    ef: { buff: 'blood frenzy', backfire: true }
};

function seasonActionFor(state: RouteState, rawSpells: readonly RawPlannerRow[] | null): SeasonSwitch | null {
    const action = state.action;
    if (action === null || rawSpells === null) { return null; }

    const key = action.split('-').pop() ?? '';
    const target = FtHofBuffTargets[key];
    if (!target) { return null; }

    const isCast = action === `fthof-${key}`;
    if (!isCast && action !== `resolve-fthof-${key}`) { return null; }

    const row = rawSpells[isCast ? state.parent?.spellIndex ?? state.spellIndex : state.spellIndex];
    if (!row) { return null; }

    const noChange = target.backfire ? row.noChangeBackfire : row.noChangeSuccess;
    const change = target.backfire ? row.changeBackfire : row.changeSuccess;
    if (noChange === target.buff) { return { text: 'Switch to no season', raw: 'season-none', icon: [16, 6, 'icons.png'], color: '#7bff69' }; }
    if (change === target.buff) { return { text: 'Switch to Easter', raw: 'season-easter', icon: [0, 12, 'icons.png'], color: '#d8ffa4' }; }

    return null;
}

function escapeHtml(text: string): string {
    let out = '';
    for (const char of text) {
        switch (char) {
            case '&': out += '&amp;'; break;
            case '<': out += '&lt;'; break;
            case '>': out += '&gt;'; break;
            case '"': out += '&quot;'; break;
            case "'": out += '&#39;'; break;
            default: out += char;
        }
    }
    return out;
}

class ActualAction {
    towerCount: number;
    additionalArrow: ActualAction | null;
    constructor(public name: string, public icon: [number, number, string], public color: string, public towerRange: [number, number], public row: number, public raw: string, additionalArrow?: ActualAction) {
        // `maxMagicToTowerCount` reports the whole span of tower counts that share
        // a max magic, which at high counts can run past any tower a player owns.
        // The caller clamps to the player's own ceiling, so refuse to carry an
        // unbounded upper end instead of failing the whole route over it.
        if (!Number.isFinite(towerRange[1]) || towerRange[1] > MAX_TOWER_COUNT) {
            this.towerRange = [towerRange[0], Math.max(towerRange[0] + 1, MAX_TOWER_COUNT)];
        } else {
            this.towerRange = towerRange;
        }
        this.towerCount = this.towerRange[0];
        this.additionalArrow = additionalArrow || null; // mainly used for resolves
    }
    registerAdditionalArrow(additionalArrow: ActualAction) {
        this.additionalArrow = additionalArrow;
    }
    align(prev: ActualAction) {
        // Attempts to fix a single tower count that minimizes the number of sells/buys to the previous action
        if (prev.towerCount >= this.towerRange[0] && prev.towerCount < this.towerRange[1]) {
            this.towerCount = prev.towerCount;
            return;
        }
        if (this.towerRange[0] + 1 === this.towerRange[1]) {
            this.towerCount = this.towerRange[0];
            return;
        }
        for (const alignment of [100, 10, 1]) {
            const diffMin = (this.towerRange[0] - prev.towerCount) / alignment, 
                diffMax = (this.towerRange[1] - 1 - prev.towerCount) / alignment;
            const prevCount = prev.towerCount;
            if (Math.abs(diffMin) < Math.abs(diffMax)) {
                // the range is greater than prevCount
                if (Math.ceil(diffMin) * alignment + prevCount < this.towerRange[1]) {
                    this.towerCount = Math.round(Math.ceil(diffMin) * alignment) + prevCount;
                    return;
                }
            } else if (Math.abs(diffMin) > Math.abs(diffMax)) {
                // the range is lesser than prevCount
                if (Math.floor(diffMax) * alignment + prevCount >= this.towerRange[0]) {
                    this.towerCount = Math.round(Math.floor(diffMax) * alignment) + prevCount;
                    return;
                }
            }
        }
    }

    /**
     * The contents of the action's box: the spritesheet icon, its name and the
     * tower count it is performed at. Colour and position belong to the wrapper
     * the panel builds, so this stays pure markup.
     *
     * The icon carries the sprite cell's pixel offset as custom properties; the
     * stylesheet points that 48x48 cell of the spritesheet named in `icon[2]`
     * (under `src/assets/` by default) at the icon box.
     */
    html(): string {
        const [column, row, sheet] = this.icon;
        return [
            `<span class="ci__icon" data-sheet="${escapeHtml(sheet)}" `,
            `style="--ci-x:${-column * ICON_SIZE}px;--ci-y:${-row * ICON_SIZE}px" aria-hidden="true"></span>`,
            `<span class="ci__text">`,
            `<span class="ci__name">${escapeHtml(this.name)}</span>`,
            `<span class="ci__count">At ${this.towerCount.toLocaleString('en-US')} towers</span>`,
            `</span>`,
        ].join('');
    }
}
export interface PolishResults {
    actions: ActualAction[];
    startRow: number;
}
function polish(state: RouteState, towerLevel: number, startCastCount: number, absMaxTowers: number, rawSpells: readonly RawPlannerRow[] | null = null): PolishResults {
    let list: ActualAction[] = [];
    const actionReverseMap: Record<string, Action> = Actions.reduce((acc, cur) => ({...acc, [cur.name]: cur}), {});
    let stateIterator = state;
    let startRow = -1;
    while(stateIterator.parent) {
        if (!stateIterator.action) {
            stateIterator = stateIterator.parent;
            continue;
        }
        if (stateIterator.action === 'preComboSkip' && startRow === -1) {
            startRow = stateIterator.spellIndex;
        }
        const polishO = actionReverseMap[stateIterator.action]!.polish;
        if (!polishO) {
            stateIterator = stateIterator.parent;
            continue;
        }
        const towerRange = polishO.towerCounts(stateIterator.parent, towerLevel);
        list.unshift(new ActualAction(
            polishO.text, 
            polishO.icon, 
            polishO.color,
            towerRange, 
            stateIterator.spellIndex,
            stateIterator.action
        ));
        // The season a buff-carrying FtHoF step must run in, right before it.
        const season = seasonActionFor(stateIterator, rawSpells);
        if (season) {
            list.unshift(new ActualAction(
                season.text,
                season.icon,
                season.color,
                towerRange,
                stateIterator.spellIndex,
                season.raw
            ));
        }
        if (stateIterator.onscreens < stateIterator.parent.onscreens) {
            for (let i = 0; i < (stateIterator.parent.onscreens - stateIterator.onscreens + 1); i++) { 
                list.unshift(new ActualAction(
                    'Click onscreen', 
                    [10, 14, 'icons.png'], 
                    '#ffd500',
                    list[0]!.towerRange, 
                    stateIterator.spellIndex,
                    'onscreen'
                )); 
            }
        }
        stateIterator = stateIterator.parent;
    }
    // A season persists until it is changed, so a switch to the season an earlier
    // switch already set is redundant: keep only the switches that change it.
    let currentSeason: string | null = null;
    list = list.filter((action) => {
        if (!action.raw.startsWith('season-')) { return true; }
        if (action.raw === currentSeason) { return false; }
        currentSeason = action.raw;
        return true;
    });
    if (!list.length) {
        return {
            actions: [],
            startRow: 0
        };
    }
    // No `preComboSkip` means the route never skipped a row: it starts where the
    // state chain does.
    if (startRow === -1) {
        startRow = stateIterator.spellIndex;
    }
    // Only the auras the run was priced for: telling the player to slot one they
    // said they do not have would contradict the route they asked for.
    if (stateIterator.restrictions.rbAllowed) {
        list.unshift(new ActualAction(
            'Slot Reality Bending',
            [32, 25, 'icons.png'],
            '#556cff',
            list[0]!.towerRange,
            stateIterator.spellIndex,
            'slotRB'
        ));
    }
    if (stateIterator.restrictions.siAllowed) {
        list.unshift(new ActualAction(
            'Slot Supreme Intellect',
            [34, 25, 'icons.png'],
            '#556cff',
            list[0]!.towerRange,
            stateIterator.spellIndex,
            'slotSI'
        ));
    }
    list.unshift(new ActualAction(
        'At cast ' + (startCastCount + 1 + startRow).toLocaleString('en-US'),
        [10, 0, 'icons.png'],
        '#556cff',
        list[0]!.towerRange,
        stateIterator.spellIndex,
        'start'
    ))
    stateIterator = state;
    list[0]!.towerCount = list[0]!.towerRange[0];
    for (let i = 0; i < list.length; i++) {
        // The first action has nothing to align to; the rest step from their
        // predecessor, then every count is capped at the towers the player owns.
        if (i > 0) {
            list[i]!.align(list[i - 1]!);
        }
        list[i]!.towerCount = Math.min(list[i]!.towerCount, absMaxTowers);
    }
    let gfdCache: ActualAction[] = [];
    for (let i = 0; i < list.length; i++) {
        if (list[i]!.raw.startsWith('g!')) {
            gfdCache.push(list[i]!);
        }
        if (list[i]!.raw.split('-')[0] === 'resolve' && gfdCache.length > 0) {
            list[i]?.registerAdditionalArrow(gfdCache.shift()!);
        }
    }
    // Now stateIterator is at the top
    return {
        actions: list,
        startRow: startRow
    };
}

/** One box of the combo-instructions panel, in a form the panel can render. */
export interface PolishedAction {
    /** The box contents, produced by `ActualAction#html()`. */
    html: string;
    /** Plain-text name, so the panel can label the box for assistive tech. */
    name: string;
    /** The action's raw name, e.g. `fthof-cf` or `resolve-fthof-bs`. */
    raw: string;
    /** Border colour; the box's fill is this colour at 30% opacity. */
    color: string;
    /** The tower count the action is performed at, once aligned to its neighbours. */
    towerCount: number;
    /** The max magic that tower count reaches at the polished tower level. */
    maxMagic: number;
    /** Index of the action its faded yellow arrow points at, or -1 for none. */
    additionalArrow: number;
}

/** Everything the combo-instructions panel needs; structured-clone friendly. */
export interface ComboInstructionsData {
    /** The combo shorthand, the same one the live "best combo" counter shows. */
    combo: string;
    /** The tower level the tower counts are computed for. */
    towerLevel: number;
    /** The cast index the route starts at. */
    startRow: number;
    actions: PolishedAction[];
}

/**
 * Flatten a polished route into data a worker can post and a panel can render.
 * `AdditionalArrow` is stored as an index because the action graph cannot be
 * structured-cloned across the worker boundary.
 */
export function serializeInstructions(results: PolishResults, towerLevel: number, combo: string): ComboInstructionsData {
    const indexOf = new Map<ActualAction, number>();
    results.actions.forEach((action, index) => indexOf.set(action, index));
    return {
        combo,
        towerLevel,
        startRow: results.startRow,
        actions: results.actions.map((action) => ({
            html: action.html(),
            name: action.name,
            raw: action.raw,
            color: action.color,
            towerCount: action.towerCount,
            maxMagic: towerCountToMaxMagic(action.towerCount, towerLevel),
            additionalArrow: action.additionalArrow === null ? -1 : indexOf.get(action.additionalArrow) ?? -1
        }))
    };
}
export default polish;
