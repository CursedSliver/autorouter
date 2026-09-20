/**
 * The upcoming-spells box: for every spell between the imported cast count and
 * the lookahead, what the row rolls and which buff it lands on, with and without
 * a season change. It is a read-only window onto `seedgen`'s data — the same rows
 * the planner purifies into `Spell`s — so the player can see what the router sees.
 */
import {
  EmphasizedBuffs,
  ProperBuffNames,
  type Buff,
  type RawPlannerRow,
} from "../app/route/seedgen";
import { query } from "../lib/dom";

/**
 * Base chance a row backfires. This mirrors `RouteState#backfires`: a roll at or
 * above `1 - chance` is the backfire, so lower rolls are the successful ones.
 */
export const BACKFIRE_CHANCE = 0.15;

const HEADERS = ["Spell #", "Random seed", "No season or Christmas", "Any other seasons"] as const;

export interface SpellPreview {
  readonly element: HTMLElement;
  /** Show the rows for `start..start + rows.length`, numbered from `start`. */
  render(start: number, rows: readonly RawPlannerRow[]): void;
}

/** The emphasised buffs are the ones worth chasing, so they carry a highlight. */
const emphasis = (text: string): HTMLSpanElement => {
  const span = document.createElement("span");
  span.className = "spell-preview__emphasized";
  span.textContent = text;

  return span;
};

const buffText = (name: string, emphasized: boolean): Node =>
  emphasized ? emphasis(name) : document.createTextNode(name);

/**
 * The text of a successful outcome. The buff is the one the roll lands on; the
 * second buff is the variant hidden behind Dragon's Fortune, which only earns a
 * mention when it matters (an emphasised buff, or the special DF building
 * special) — and every emphasised name gets the highlight, shorthand included.
 */
const appendSuccess = (cell: HTMLElement, main: Buff, hidden: Buff, dfBs: boolean): void => {
  cell.append(buffText(ProperBuffNames[main], EmphasizedBuffs.has(main)));

  if (hidden !== main && EmphasizedBuffs.has(hidden)) {
    cell.append(" ", emphasis(`(${ProperBuffNames[hidden]})`));
  }

  if (dfBs) {
    // Disabled until it could handle df-bs
    //cell.append(" ", emphasis("(DF-BS)"));
  }
};

const cell = (className: string, text: string): HTMLTableCellElement => {
  const td = document.createElement("td");
  td.className = className;
  td.textContent = text;

  return td;
};

export function createSpellPreview(): SpellPreview {
  const element = document.createElement("div");
  element.className = "spell-preview";

  const head = HEADERS.map((label) => `<th scope="col">${label}</th>`).join("");

  element.innerHTML = `
    <div class="spell-preview__scroll">
      <table class="spell-preview__table">
        <thead>
          <tr>${head}</tr>
        </thead>
        <tbody data-preview-body></tbody>
      </table>
    </div>
    <p class="spell-preview__hint">
      The spells starting from the cast count: each one's GFD roll, with the buff it lands
      with no season change and under any other season. Red-tinted rows indicate that it backfires by default. 
      Buffs in parentheses indicate outcomes only accessible by changing backfire chance.
      <br>
      The autorouter will attempt to find a best route within the spells shown ONLY. To adjust the amount, adjust the lookahead.
    </p>
  `;

  const body = query<HTMLTableSectionElement>(element, "[data-preview-body]");

  const emptyRow = (): HTMLTableRowElement => {
    const row = document.createElement("tr");
    const td = document.createElement("td");
    td.className = "spell-preview__empty";
    td.colSpan = HEADERS.length;
    td.textContent = "Nothing imported yet — paste a save or seed above to preview the upcoming spells.";
    row.append(td);

    return row;
  };

  const outcomeCell = (row: RawPlannerRow, start: number, change: boolean): HTMLTableCellElement => {
    const backfires = row.gfdRs >= 1 - BACKFIRE_CHANCE;

    if (backfires) {
      const buff = change ? row.changeBackfire : row.noChangeBackfire;
      const td = document.createElement("td");
      td.className = "spell-preview__buff spell-preview__buff--backfire";
      td.append(buffText(ProperBuffNames[buff], EmphasizedBuffs.has(buff)));
      td.title = `Spell ${start} backfires on this roll`;

      return td;
    }

    const td = document.createElement("td");
    td.className = "spell-preview__buff";

    if (change) {
      appendSuccess(td, row.changeSuccess, row.changeBackfire, row.changeDFSuccess === 'building special');
    } else {
      appendSuccess(td, row.noChangeSuccess, row.noChangeBackfire, row.noChangeDFSuccess === 'building special');
    }

    return td;
  };

  const render = (start: number, rows: readonly RawPlannerRow[]): void => {
    body.replaceChildren();

    if (rows.length === 0) {
      body.append(emptyRow());

      return;
    }

    rows.forEach((row, offset) => {
      const index = start + offset + 1;
      const tr = document.createElement("tr");
      tr.className = "spell-preview__row";
      tr.append(
        cell("spell-preview__index", String(index)),
        cell("spell-preview__seed", row.gfdRs.toFixed(5)),
        outcomeCell(row, index, false),
        outcomeCell(row, index, true),
      );
      body.append(tr);
    });
  };

  render(0, []);

  return { element, render };
}
