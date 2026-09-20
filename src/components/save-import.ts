/**
 * The import box: paste a save (or a bare 5-character seed) and turn it into a
 * seed plus a cast count, which is all `seedgen` needs to rebuild the spell
 * queue. Saves carry their own cast count; a bare seed has to be told one, which
 * is what the second field is for. Importing is repeatable — every import
 * replaces the current seed wholesale.
 */
import { extractSeedFromSave, type RawPlannerRow } from "../app/route/seedgen";
import { query } from "../lib/dom";
import { createSpellPreview } from "./spell-preview";

/** A parsed save/seed: the raw seed plus how many spells the player has cast. */
export interface SeedImport {
  seed: string;
  spellsCastTotal: number;
}

export interface SaveImportHandlers {
  /** Called with a valid parse; the caller owns the resulting state. */
  onImport(result: SeedImport): void;
  /** Called while the cast-count field is edited, so the toolbar can mirror it. */
  onCastCountChange(value: number | null): void;
}

export interface SaveImportBox {
  readonly element: HTMLElement;
  setCastCount(value: number | null): void;
  /** Fill the box and run the same import path a paste would; used by URL loading. */
  loadSeed(seed: string, casts: number | null): void;
  preview(start: number, rows: readonly RawPlannerRow[]): void;
  clearWarning(): void;
}

export function createSaveImport(handlers: SaveImportHandlers): SaveImportBox {
  const element = document.createElement("section");
  element.className = "import";
  element.innerHTML = `
    <label class="field field--wide">
      <span class="field__label">input save or seed</span>
      <input
        class="field__input field__input--wide"
        type="text"
        name="save"
        autocomplete="off"
        spellcheck="false"
        placeholder="Paste a Cookie Clicker save, or a 5-character seed"
      />
    </label>
    <div class="import__row">
      <label class="field">
        <span class="field__label">Spells casted all time</span>
        <input
          class="field__input"
          type="number"
          name="importCasts"
          min="0"
          step="1"
          placeholder="optional for save inputs"
        />
      </label>
      <button class="button button--primary" type="button" data-import>Import save</button>
    </div>
    <p class="import__warning" data-import-warning hidden></p>
    <div data-preview-host></div>
  `;

  const saveInput = query<HTMLInputElement>(element, 'input[name="save"]');
  const castsInput = query<HTMLInputElement>(element, 'input[name="importCasts"]');
  const warning = query<HTMLElement>(element, "[data-import-warning]");

  const preview = createSpellPreview();
  query<HTMLElement>(element, "[data-preview-host]").append(preview.element);

  const castCount = (): number | null => {
    const parsed = Number.parseInt(castsInput.value, 10);

    return Number.isFinite(parsed) ? parsed : null;
  };

  const warn = (message: string): void => {
    warning.textContent = message;
    warning.hidden = false;
  };

  const clearWarning = (): void => {
    warning.textContent = "";
    warning.hidden = true;
  };

  const importSave = (source?: { raw: string; casts: number | null }): void => {
    const raw = (source?.raw ?? saveInput.value).trim();
    const typed = source ? source.casts : castCount();
    const isSeed = raw.length === 5;
    const forced = isSeed ? typed : null;

    if (raw.length === 0) {
      warn("Paste a Cookie Clicker save or a 5-character seed first.");

      return;
    }

    if (isSeed && (forced === null || forced < 0)) {
      warn('A bare seed needs a positive "Spells casted all time" — saves carry their own count.');

      return;
    }

    let parsed;

    try {
      parsed = extractSeedFromSave(raw, forced === null ? undefined : forced);
    } catch (e) {
      warn("That is not a valid save or seed — check that the whole thing was pasted in.");
      console.error(e);

      return;
    }

    clearWarning();
    castsInput.value = String(parsed.spellsCastTotal);
    handlers.onImport(parsed);
  };

  element.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest("[data-import]")) return;

    importSave();
  });

  // Enter belongs to the import button, not to the form: submitting here would
  // otherwise start a route search from a half-filled form.
  element.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;

    event.preventDefault();
    importSave();
  });

  const onEdited = (): void => {
    clearWarning();
    handlers.onCastCountChange(castCount());
  };

  saveInput.addEventListener("input", clearWarning);
  castsInput.addEventListener("input", onEdited);

  return {
    element,
    setCastCount: (value) => {
      castsInput.value = value === null ? "" : String(value);
    },
    loadSeed: (seed, casts) => {
      saveInput.value = seed;
      castsInput.value = casts !== null && casts > 0 ? String(casts) : "";
      importSave({ raw: seed, casts });
    },
    preview: (start, rows) => {
      preview.render(start, rows);
    },
    clearWarning,
  };
}
