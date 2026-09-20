import type { Spell } from "../app/route/route";
import { query } from "../lib/dom";
import { SPELL_FLAGS, clampRoll, createSpell, isSpellFlag } from "../lib/spell";

export interface SpellTable {
  readonly element: HTMLTableElement;
  readonly size: number;
  getSpells(): Spell[];
  setSpells(spells: readonly Spell[]): void;
  appendSpell(): void;
}

const FlagsTextMap = {
  cf: 'CF',
  bs: 'BS',
  ef: 'EF',
  dfBs: 'DF-BS'
}
export function createSpellTable(initial: readonly Spell[]): SpellTable {
  const spells: Spell[] = initial.map((spell) => ({ ...spell }));

  const element = document.createElement("table");
  element.className = "spell-table";
  element.innerHTML = `
    <caption class="spell-table__caption">
      Direct spell input: one row per upcoming spell, bypassing the seed import.
      <br>Whenever ready, press Click to route combo to start autorouting.
    </caption>
    <thead>
      <tr>
        <th class="spell-table__index" scope="col">#</th>
        ${SPELL_FLAGS.map((flag) => `<th scope="col">${FlagsTextMap[flag]}</th>`).join("")}
        <th scope="col">GFD RS</th>
        <th class="spell-table__actions" scope="col">
          <span class="visually-hidden">Row actions</span>
        </th>
      </tr>
    </thead>
    <tbody></tbody>
  `;

  const body = query<HTMLTableSectionElement>(element, "tbody");

  const positionOf = (target: Element): number => {
    const row = target.closest("tr");
    const raw = row instanceof HTMLTableRowElement ? row.dataset.position : undefined;

    if (raw === undefined) return -1;

    const position = Number.parseInt(raw, 10);

    return Number.isNaN(position) ? -1 : position;
  };

  const createRow = (spell: Spell): HTMLTableRowElement => {
    const row = document.createElement("tr");
    row.className = "spell-table__row";

    const index = document.createElement("th");
    index.className = "spell-table__index";
    index.scope = "row";
    row.append(index);

    for (const flag of SPELL_FLAGS) {
      const cell = document.createElement("td");
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "spell-table__toggle";
      toggle.dataset.flag = flag;
      toggle.checked = spell[flag];
      cell.append(toggle);
      row.append(cell);
    }

    const rollCell = document.createElement("td");
    const roll = document.createElement("input");
    roll.type = "number";
    roll.className = "spell-table__number";
    roll.min = "0";
    roll.max = "0.99";
    roll.step = "0.01";
    roll.value = String(spell.gfdRs);
    rollCell.append(roll);
    row.append(rollCell);

    const actions = document.createElement("td");
    actions.className = "spell-table__actions";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "spell-table__remove";
    remove.dataset.action = "remove";
    remove.textContent = "×";
    actions.append(remove);
    row.append(actions);

    return row;
  };

  const label = (row: HTMLTableRowElement, position: number): void => {
    row.dataset.position = String(position);

    const index = row.querySelector<HTMLTableCellElement>(".spell-table__index");
    if (index) index.textContent = String(position + 1);

    for (const toggle of row.querySelectorAll<HTMLInputElement>(".spell-table__toggle")) {
      toggle.setAttribute("aria-label", `Spell ${position + 1}: ${toggle.dataset.flag ?? "flag"}`);
    }

    const roll = row.querySelector<HTMLInputElement>(".spell-table__number");
    roll?.setAttribute("aria-label", `Spell ${position + 1}: gfdRs`);

    const remove = row.querySelector<HTMLButtonElement>(".spell-table__remove");
    remove?.setAttribute("aria-label", `Remove spell ${position + 1}`);
  };

  const render = (): void => {
    body.replaceChildren();

    if (spells.length === 0) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.className = "spell-table__empty";
      cell.colSpan = SPELL_FLAGS.length + 3;
      cell.textContent = "No spells yet — the route has nothing to resolve.";
      row.append(cell);
      body.append(row);

      return;
    }

    spells.forEach((spell, position) => {
      const row = createRow(spell);
      label(row, position);
      body.append(row);
    });
  };

  body.addEventListener("change", (event) => {
    const target = event.target;

    if (!(target instanceof HTMLInputElement)) return;

    const spell = spells[positionOf(target)];

    if (!spell) return;

    if (target.type === "checkbox") {
      const flag = target.dataset.flag;

      if (isSpellFlag(flag)) spell[flag] = target.checked;

      return;
    }

    if (!target.classList.contains("spell-table__number")) return;

    const roll = clampRoll(Number.parseFloat(target.value));

    spell.gfdRs = roll;
    target.value = String(roll);
  });

  body.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest(".spell-table__remove")) return;

    const position = positionOf(event.target);

    if (position < 0) return;

    spells.splice(position, 1);
    render();
  });

  render();

  return {
    element,
    get size() {
      return spells.length;
    },
    getSpells: () => spells.map((spell) => ({ ...spell })),
    setSpells: (next) => {
      spells.splice(0, spells.length, ...next.map((spell) => ({ ...spell })));
      render();
    },
    appendSpell: () => {
      spells.push(createSpell());
      render();
    },
  };
}
