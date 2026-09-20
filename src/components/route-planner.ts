import type { RouteProgress } from "../app/route/route";
import type { ComboInstructionsData } from "../app/route/polish";
import {
  generatePlannerData,
  purifyPlannerData,
  towerCountToMaxMagic,
  type RawPlannerRow,
} from "../app/route/seedgen";
import { fullCombo, shorthandCombo } from "../lib/combo";
import { query } from "../lib/dom";
import { clampTowerCount, clampTowerLevel, towersForMaxMagic } from "../lib/max-magic";
import { DEFAULT_SPELLS } from "../lib/spell";
import { plannerShareUrl, readPlannerUrlParams, type PlannerUrlParams } from "../lib/url-params";
import { createComboInstructions } from "./combo-instructions";
import { createSaveImport } from "./save-import";
import { createSpellTable } from "./spell-table";
import type {
  RouteRequest,
  RouteSnapshot,
  RouteWorkerMessage,
  RouteWorkerRequest,
} from "./route-worker";

const DEFAULT_METAMAX = 100;
const DEFAULT_GOAL = 1;
const DEFAULT_LOOKAHEAD = 10;
const DEFAULT_REFILLS = 1;
/** Above this the search tree grows fast enough to warn about. */
const LOOKAHEAD_WARN_ABOVE = 20;

const seconds = (elapsed: number): string => `${(elapsed / 1000).toFixed(1)} s`;

/** Counts and throughput share a voice, so tens of thousands stay readable. */
const branches = (count: number): string =>
  count.toLocaleString("en-US");

/**
 * The search is a long synchronous loop, so it runs in a worker
 * (`components/route-worker.ts`) where it cannot block the page: the UI only
 * reads progress messages and, to halt, terminates the worker. The URL points at
 * the built file, which `scripts/build.mjs` emits as a `route-worker` entry.
 */
const createSearchWorker = (): Worker =>
  new Worker(new URL("./route-worker.js", import.meta.url), { type: "module" });

export function createRoutePlanner(): HTMLElement {
  const section = document.createElement("section");
  section.className = "planner";
  section.innerHTML = `
    <form class="planner__form" novalidate>
      <div data-import-host></div>

      <div class="planner__direct">
        <div class="planner__direct-row">
          <button
            class="button"
            type="button"
            data-toggle-direct
            aria-expanded="false"
            aria-controls="direct-spell-input"
          >
            direct spell input
          </button>
          <div class="planner__share">
            <span class="planner__share-status" data-share-status aria-live="polite"></span>
            <button class="button" type="button" data-share>share link</button>
          </div>
        </div>
        <div class="planner__direct-body" id="direct-spell-input" data-direct-body hidden>
          <div data-table-host></div>
          <p class="planner__hint">
            For each row, if an effect exists anywhere inside the row (including if hidden behind
            backfires), check the box. Then, input GFD RS, which stands for GFD random seed.
          </p>
        </div>
      </div>

      <div class="planner__toolbar">
        <label class="field">
          <span class="field__label">spells casted all time</span>
          <input class="field__input" type="number" name="castTotal" min="0" step="1" disabled />
        </label>
        <label class="field">
          <span class="field__label">lookahead</span>
          <input
            class="field__input"
            type="number"
            name="lookahead"
            min="1"
            max="40"
            step="1"
            value="${DEFAULT_LOOKAHEAD}"
            disabled
          />
        </label>
        <div class="field" data-maxmagic hidden>
          <span class="field__label">maximum max magic | tower count | level</span>
          <div class="field__linked">
            <input class="field__chunk" type="number" name="metamax" min="1" step="1" aria-label="max magic" />
            <input
              class="field__chunk"
              type="number"
              name="towers"
              min="1"
              max="4939"
              step="1"
              aria-label="tower count"
            />
            <input
              class="field__chunk"
              type="number"
              name="towerLevel"
              min="1"
              max="18"
              step="1"
              aria-label="tower level"
            />
          </div>
        </div>
        <label class="field" data-mandatory="current" hidden>
          <span class="field__label">current</span>
          <input class="field__input" type="number" name="current" min="0" step="1" />
        </label>
        <div class="field" data-mandatory="refills" hidden>
          <span class="field__label">max refills</span>
          <div class="choice" role="radiogroup" aria-label="max refills" data-refills>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="refills" value="0" />
              <span class="choice__label">0</span>
            </label>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="refills" value="1" />
              <span class="choice__label">1</span>
            </label>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="refills" value="2" />
              <span class="choice__label">2</span>
            </label>
          </div>
        </div>
        <label class="field" style="display: none;">
          <span class="field__label">goal</span>
          <input class="field__input" type="number" name="goal" min="0" step="1" value="${DEFAULT_GOAL}" />
        </label>
      </div>

      <p class="field__warning" data-lookahead-warning hidden>
        A high lookahead may cause routing to take a long time
      </p>

      <div class="planner__restrictions">
        <div class="field" data-mandatory="si" hidden>
          <span class="field__label">Supreme Intellect available</span>
          <div class="choice choice--text" role="radiogroup" aria-label="Supreme Intellect available" data-si>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="si" value="true" />
              <span class="choice__label">Yes</span>
            </label>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="si" value="false" />
              <span class="choice__label">No</span>
            </label>
          </div>
        </div>
        <div class="field" data-mandatory="rb" hidden>
          <span class="field__label">Reality Bending available</span>
          <div class="choice choice--text" role="radiogroup" aria-label="Reality Bending available" data-rb>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="rb" value="true" />
              <span class="choice__label">Yes</span>
            </label>
            <label class="choice__option">
              <input class="choice__input" type="radio" name="rb" value="false" />
              <span class="choice__label">No</span>
            </label>
          </div>
        </div>
      </div>

      <button class="button button--primary planner__route" type="submit" data-run disabled>
        Click to route combo
      </button>

      <div class="planner__live" data-live-host hidden>
        <dl class="metrics metrics--live">
          <div class="metrics__item">
            <dt class="metrics__label">Branches</dt>
            <dd class="metrics__value" data-live="branches">0</dd>
          </div>
          <div class="metrics__item">
            <dt class="metrics__label">Branches / s</dt>
            <dd class="metrics__value" data-live="rate">0</dd>
          </div>
          <div class="metrics__item">
            <dt class="metrics__label">Best combo</dt>
            <dd class="metrics__value" data-live="combo">—</dd>
          </div>
          <div class="metrics__item">
            <dt class="metrics__label">Elapsed</dt>
            <dd class="metrics__value" data-live="elapsed">0.0 s</dd>
          </div>
        </dl>
      </div>
    </form>
    <div class="planner__result" data-result-host aria-live="polite"></div>
    <div class="warning">
      <p class="warning__title">Notes</p>
      <p class="warning__text">AI disclaimer: Core routing logic is entirely handwritten; AI is ONLY used in the creation of the UI.</p>
    </div>
  `;

  const form = query<HTMLFormElement>(section, "form");
  const tableHost = query<HTMLElement>(section, "[data-table-host]");
  const directBody = query<HTMLElement>(section, "[data-direct-body]");
  const directButton = query<HTMLButtonElement>(section, "[data-toggle-direct]");
  const shareButton = query<HTMLButtonElement>(section, "[data-share]");
  const shareStatus = query<HTMLElement>(section, "[data-share-status]");
  const importHost = query<HTMLElement>(section, "[data-import-host]");
  const resultHost = query<HTMLElement>(section, "[data-result-host]");
  const maxMagicField = query<HTMLElement>(section, "[data-maxmagic]");
  const maxMagicInput = query<HTMLInputElement>(section, 'input[name="metamax"]');
  const towersInput = query<HTMLInputElement>(section, 'input[name="towers"]');
  const towerLevelInput = query<HTMLInputElement>(section, 'input[name="towerLevel"]');
  const castTotalInput = query<HTMLInputElement>(section, 'input[name="castTotal"]');
  const lookaheadInput = query<HTMLInputElement>(section, 'input[name="lookahead"]');
  const lookaheadWarning = query<HTMLElement>(section, "[data-lookahead-warning]");
  const currentField = query<HTMLElement>(section, '[data-mandatory="current"]');
  const currentInput = query<HTMLInputElement>(section, 'input[name="current"]');
  const refillsField = query<HTMLElement>(section, '[data-mandatory="refills"]');
  const refillsChoice = query<HTMLElement>(section, "[data-refills]");
  const refillsRadios = [...section.querySelectorAll<HTMLInputElement>('input[name="refills"]')];
  const siField = query<HTMLElement>(section, '[data-mandatory="si"]');
  const rbField = query<HTMLElement>(section, '[data-mandatory="rb"]');
  const siChoice = query<HTMLElement>(section, "[data-si]");
  const rbChoice = query<HTMLElement>(section, "[data-rb]");
  const siRadios = [...section.querySelectorAll<HTMLInputElement>('input[name="si"]')];
  const rbRadios = [...section.querySelectorAll<HTMLInputElement>('input[name="rb"]')];
  const goalInput = query<HTMLInputElement>(section, 'input[name="goal"]');
  const runButton = query<HTMLButtonElement>(section, "[data-run]");
  const liveHost = query<HTMLElement>(section, "[data-live-host]");
  const liveBranches = query<HTMLElement>(section, '[data-live="branches"]');
  const liveRate = query<HTMLElement>(section, '[data-live="rate"]');
  const liveCombo = query<HTMLElement>(section, '[data-live="combo"]');
  const liveElapsed = query<HTMLElement>(section, '[data-live="elapsed"]');

  const table = createSpellTable(DEFAULT_SPELLS);
  tableHost.append(table.element);

  // Editing the queue decouples it from the imported seed, so the raw rows the
  // season instructions come from can no longer be trusted.
  const invalidateRawSpells = (): void => {
    rawSpells = null;
  };
  table.element.addEventListener("change", invalidateRawSpells);
  table.element.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(".spell-table__remove")) {
      invalidateRawSpells();
    }
  });

  /** The imported seed; nothing routes from it until the first valid import. */
  let seed: string | null = null;
  /**
   * The raw rows behind the current queue, or null once the queue is hand-typed:
   * the season instructions are read from them, so a manual queue disables them.
   */
  let rawSpells: RawPlannerRow[] | null = null;
  /** The worker, kept between runs so the core's tables are built only once. */
  let worker: Worker | null = null;
  let running = false;
  let runStartedAt = 0;
  /** Last progress report; it is all that survives a halt. */
  let latestProgress: RouteProgress | null = null;
  /** The counters of that report, so the next one can measure a throughput. */
  let lastSample: { steps: number; elapsed: number } | null = null;
  /** Branches per second, smoothed across reports; see `sampleBranchRate`. */
  let branchRate = 0;
  /** Max magic of the last run, so a tower level change knows how many towers reach it. */
  let routeMetamax = DEFAULT_METAMAX;
  /** The in-flight tower-level repaint, if the panel asked for one. */
  let polishResolver: {
    resolve: (data: ComboInstructionsData) => void;
    reject: (error: unknown) => void;
  } | null = null;

  /**
   * Re-polish the last route at a tower level. The tower counts in the
   * instructions are derived from the level, so only the worker — which still
   * holds the route and the tables that derive them — can recompute them.
   */
  const requestPolish = (towerLevel: number): Promise<ComboInstructionsData> =>
    new Promise((resolve, reject) => {
      const search = worker;

      if (search === null) {
        reject(new Error("No route to re-polish"));

        return;
      }

      // A newer request supersedes an unanswered one.
      polishResolver?.reject(new Error("Superseded by a newer tower level"));
      polishResolver = { resolve, reject };

      const message: RouteWorkerRequest = {
        kind: "polish",
        towerLevel,
        absMaxTowers: towersForMaxMagic(routeMetamax, towerLevel),
      };

      search.postMessage(message);
    });

  const combo = createComboInstructions({ requestPolish });

  /** The field's value as a number, or null while it is blank or unusable. */
  const readNumber = (input: HTMLInputElement): number | null => {
    const parsed = Number.parseInt(input.value, 10);

    return Number.isFinite(parsed) ? parsed : null;
  };

  const readInteger = (
    input: HTMLInputElement,
    fallback: number,
    min: number,
    max?: number,
  ): number => {
    const parsed = Number.parseInt(input.value, 10);
    let value = Number.isFinite(parsed) ? Math.max(parsed, min) : fallback;

    if (max !== undefined) value = Math.min(value, max);
    input.value = String(value);

    return value;
  };

  /** Which refill option is picked, or null while none of the three is. */
  const readRefills = (): number | null => {
    const picked = refillsRadios.find((radio) => radio.checked);

    return picked ? Number.parseInt(picked.value, 10) : null;
  };

  /** What an availability selector says, or null while neither button is picked. */
  const readAvailability = (radios: readonly HTMLInputElement[]): boolean | null => {
    const picked = radios.find((radio) => radio.checked);

    return picked ? picked.value === "true" : null;
  };

  /** The seven inputs a route needs before the button will do anything. */
  const routeReady = (): boolean =>
    readNumber(castTotalInput) !== null &&
    readNumber(lookaheadInput) !== null &&
    readNumber(maxMagicInput) !== null &&
    readNumber(currentInput) !== null &&
    readRefills() !== null &&
    readAvailability(siRadios) !== null &&
    readAvailability(rbRadios) !== null;

  /**
   * Without every input there is nothing to route, so the button greys out and
   * refuses the click; a search in flight keeps it live so it can still be
   * halted.
   */
  const updateRouteAvailability = (): void => {
    runButton.disabled = !running && !routeReady();
  };

  /** A lookahead past the warn threshold is slow enough to say so, in place. */
  const syncLookaheadWarning = (): void => {
    const lookahead = readNumber(lookaheadInput);
    lookaheadWarning.hidden = lookahead === null || lookahead <= LOOKAHEAD_WARN_ABOVE;
  };

  /**
   * Current magic is bounded by the max magic, so max magic drags it along: the
   * attribute keeps the browser's own validation honest, an empty field follows
   * the cap, and anything typed past the cap is pulled back to it. A value the
   * player set below the cap is left alone.
   */
  const syncCurrentCap = (): void => {
    const metamax = readNumber(maxMagicInput);

    if (metamax === null) return;

    currentInput.max = String(metamax);

    const current = readNumber(currentInput);

    if (current === null || current > metamax) currentInput.value = String(metamax);
  };

  const clampField = (input: HTMLInputElement, clamp: (value: number) => number): number | null => {
    const value = readNumber(input);

    if (value === null) return null;

    const next = clamp(value);
    input.value = String(next);

    return next;
  };

  /**
   * Max magic, tower count and tower level describe the same fact, so editing
   * one has to move the others. The tower level picks the direction: with a level
   * in hand, editing max magic solves for the fewest towers that reach it, while
   * editing the count or the level recomputes max magic from the count.
   */
  const linkMaxMagic = (source: "maxMagic" | "towers" | "level"): void => {
    const level = readNumber(towerLevelInput);

    if (source === "maxMagic") {
      const maxMagic = readNumber(maxMagicInput);

      if (level === null || maxMagic === null) return;

      towersInput.value = String(towersForMaxMagic(maxMagic, level));
      syncCurrentCap();

      return;
    }

    const towers = readNumber(towersInput);

    if (level === null || towers === null) return;

    maxMagicInput.value = String(towerCountToMaxMagic(towers, level));
    syncCurrentCap();
  };

  /**
   * Rebuild the queue and the preview from the imported seed. Both are fed from
   * the same rows, so what the box shows is exactly what the router routes.
   */
  const regenerate = (): void => {
    if (seed === null) return;

    const start = readNumber(castTotalInput) ?? 0;
    const lookahead = Math.max(readNumber(lookaheadInput) ?? DEFAULT_LOOKAHEAD, 1);
    const rows = generatePlannerData(seed, start, start + lookahead);

    rawSpells = rows;
    table.setSpells(purifyPlannerData(rows));
    importBox.preview(start, rows);
  };

  /**
   * The mandatory fields stay out of the way until a seed exists. Importing fills
   * the cast count itself and reveals the rest, which the player then owns.
   */
  const revealImported = (): void => {
    maxMagicField.hidden = false;
    currentField.hidden = false;
    refillsField.hidden = false;
    siField.hidden = false;
    rbField.hidden = false;
    castTotalInput.disabled = false;
    lookaheadInput.disabled = false;
  };

  const importBox = createSaveImport({
    onImport: (result) => {
      seed = result.seed;
      revealImported();
      castTotalInput.value = String(result.spellsCastTotal);
      importBox.setCastCount(result.spellsCastTotal);
      regenerate();
      updateRouteAvailability();
    },
    onCastCountChange: (value) => {
      castTotalInput.value = value === null ? "" : String(value);
      regenerate();
      updateRouteAvailability();
    },
  });

  importHost.append(importBox.element);

  maxMagicInput.addEventListener("input", () => {
    linkMaxMagic("maxMagic");
    updateRouteAvailability();
  });

  towersInput.addEventListener("input", () => {
    clampField(towersInput, clampTowerCount);
    linkMaxMagic("towers");
    updateRouteAvailability();
  });

  towerLevelInput.addEventListener("input", () => {
    clampField(towerLevelInput, clampTowerLevel);
    linkMaxMagic("level");
    updateRouteAvailability();
  });

  castTotalInput.addEventListener("input", () => {
    importBox.setCastCount(readNumber(castTotalInput));
    regenerate();
    updateRouteAvailability();
  });

  lookaheadInput.addEventListener("input", () => {
    syncLookaheadWarning();
    regenerate();
    updateRouteAvailability();
  });

  for (const input of [maxMagicInput, currentInput]) {
    input.addEventListener("input", updateRouteAvailability);
  }

  // Every radio group gates the run button the same way: a missing pick is a
  // missing input.
  for (const choice of [refillsChoice, siChoice, rbChoice]) {
    choice.addEventListener("change", updateRouteAvailability);
  }

  /** The current form state as the URL that would rebuild it on load. */
  const currentShareUrl = (): string =>
    plannerShareUrl(window.location.href, {
      seed: seed,
      casts: readNumber(castTotalInput),
      maxMagic: readNumber(maxMagicInput),
      towerCount: readNumber(towersInput),
      towerLevel: readNumber(towerLevelInput),
      refills: readRefills(),
      si: readAvailability(siRadios),
      rb: readAvailability(rbRadios),
      currentMagic: readNumber(currentInput),
      lookahead: readNumber(lookaheadInput),
    });

  /** Copy text, preferring the async clipboard and falling back to a selection. */
  const copyText = async (text: string): Promise<boolean> => {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);

        return true;
      } catch {
        // Blocked (insecure context, denied permission): try the legacy path.
      }
    }

    const scratch = document.createElement("textarea");
    scratch.value = text;
    scratch.setAttribute("readonly", "");
    scratch.style.position = "fixed";
    scratch.style.opacity = "0";
    document.body.append(scratch);
    scratch.select();

    let copied = false;

    try {
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    }

    scratch.remove();

    return copied;
  };

  let shareReset: ReturnType<typeof setTimeout> | null = null;

  const reportShare = (message: string): void => {
    shareStatus.textContent = message;

    if (shareReset !== null) clearTimeout(shareReset);

    shareReset = setTimeout(() => {
      shareStatus.textContent = "";
      shareReset = null;
    }, 2000);
  };

  shareButton.addEventListener("click", () => {
    void copyText(currentShareUrl()).then((copied) => {
      reportShare(copied ? "link copied" : "could not copy");
    });
  });

  directButton.addEventListener("click", () => {
    // The spell table is the fallback for rows that do not come from a seed.
    const open = directBody.hidden;
    directBody.hidden = !open;
    directButton.setAttribute("aria-expanded", String(open));
  });

  /** One button serves both ends: it starts a search, and stops the one in flight. */
  const setRunning = (next: boolean): void => {
    running = next;
    runButton.classList.toggle("button--primary", !next);
    runButton.classList.toggle("button--halt", next);
    runButton.textContent = next ? "Halt" : "Click to route combo";
    runButton.title = next
      ? "Stop the search; the best score found so far is kept"
      : "Search for the best route";
    runButton.setAttribute("aria-label", next ? "Halt the running search" : "Route the combo");
    updateRouteAvailability();
  };

  /**
   * The live counters, written in place so the row keeps its shape while the
   * search runs. Before the first report there is nothing to read, and a
   * made-up zero would be a claim the search has not made: `progress` is null
   * then, and the counters show a dash instead.
   */
  const renderLiveStats = (
    progress: RouteProgress | null,
    elapsed: number,
    halted: boolean,
  ): void => {
    const counter = (value: number): string => (progress === null ? "—" : branches(value));

    liveHost.hidden = false;
    liveHost.classList.toggle("planner__live--halted", halted);
    liveBranches.textContent = counter(progress?.steps ?? 0);
    liveRate.textContent = counter(Math.round(branchRate));
    liveCombo.textContent = progress === null ? "—" : shorthandCombo(progress.combo);
    liveElapsed.textContent = seconds(elapsed);
  };

  /**
   * Branch throughput between two reports, as an exponential average: half the
   * running value and half the newest sample, so one slow report cannot make the
   * counter jump. The first report has nothing to average with and stands alone.
   */
  const sampleBranchRate = (progress: RouteProgress, elapsed: number): void => {
    const from = lastSample;
    const span = from === null ? elapsed / 1000 : (elapsed - from.elapsed) / 1000;

    lastSample = { steps: progress.steps, elapsed };

    if (span <= 0) return;

    const sample = (progress.steps - (from?.steps ?? 0)) / span;
    branchRate = from === null ? sample : branchRate * 0.5 + sample * 0.5;
  };

  /**
   * The result card wears one state at a time: dashed while it has nothing to
   * show, red-rimmed when the search failed, plain otherwise.
   */
  const setResultState = (state: "idle" | "error" | null): void => {
    resultHost.classList.toggle("planner__result--idle", state === "idle");
    resultHost.classList.toggle("planner__result--error", state === "error");
  };

  /**
   * The result box sits below the form, so the first finished run of a session
   * scrolls it into view. Only the first: after that the player knows where the
   * box is, and a run they started by hand should not yank the page around.
   */
  let resultRevealed = false;

  const revealResult = (): void => {
    if (resultRevealed) return;

    resultRevealed = true;
    resultHost.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
      block: "nearest",
    });
  };

  /** What the card says before the first run: an empty box reads as a bug. */
  const renderIdle = (): void => {
    setResultState("idle");

    const paragraph = document.createElement("p");
    paragraph.className = "planner__note";
    paragraph.textContent =
      'Nothing routed yet — import a save or fill in the queue above, then press "Click to route combo". The best route found will appear here.';
    resultHost.replaceChildren(paragraph);
  };

  const renderResult = (result: RouteSnapshot, instructions: ComboInstructionsData): void => {
    const chips = [
      `magic remaining ${result.magic}`,
      `refills remaining ${result.refills}`,
      `${(Math.round(result.elapsed / 10) / 100).toLocaleString("en-US")} s`,
    ];

    setResultState(null);
    resultHost.innerHTML = `
      <dl class="metrics">
        <div class="metrics__item metrics__item--combo">
          <dt class="metrics__label">Final combo</dt>
          <dd class="metrics__value">${fullCombo(result)}</dd>
        </div>
      </dl>
      <div data-combo-host></div>
      <div class="planner__footer">
        <ul class="chips">${chips.map((chip) => `<li class="chip">${chip}</li>`).join("")}</ul>
      </div>
    `;
    query<HTMLElement>(resultHost, "[data-combo-host]").append(combo.element);
    combo.render(instructions);
  };

  const renderFailure = (message: string, elapsed: number): void => {
    setResultState("error");

    const paragraph = document.createElement("p");
    paragraph.className = "planner__error";
    const heading = document.createElement("strong");
    heading.textContent = "route() failed";

    paragraph.append(heading, ` after ${elapsed.toFixed(0)} ms — ${message}`);
    resultHost.replaceChildren(paragraph);
  };

  /** What the result card says while a search is in flight. */
  const renderSearching = (): void => {
    setResultState(null);

    const paragraph = document.createElement("p");
    paragraph.className = "planner__note";
    paragraph.textContent =
      "Searching for the best route — the counters above follow its branches, throughput and best combo, and the run button halts it.";
    resultHost.replaceChildren(paragraph);
  };

  /** A halted search has no result: only the last report says how far it got. */
  const renderHalted = (elapsed: number): void => {
    setResultState(null);

    const paragraph = document.createElement("p");
    paragraph.className = "planner__note planner__note--warn";
    paragraph.textContent = latestProgress
      ? `Halted after ${seconds(elapsed)} with ${branches(latestProgress.steps)} branches explored. Best score found so far: ${latestProgress.score} — the search did not finish, so a better route may exist.`
      : `Halted after ${seconds(elapsed)}, before the search reported any progress.`;
    resultHost.replaceChildren(paragraph);
  };

  const run = (): void => {
    const metamax = readInteger(maxMagicInput, DEFAULT_METAMAX, 1);
    const refills = Math.min(Math.max(readRefills() ?? DEFAULT_REFILLS, 0), 2) as 0 | 1 | 2;
    const current = readInteger(currentInput, metamax, 0, metamax);
    const goal = readInteger(goalInput, DEFAULT_GOAL, 0);
    const spells = table.getSpells();
    // The tower level only shapes the instructions; a blank field means level 1.
    const towerLevel = clampTowerLevel(readNumber(towerLevelInput) ?? 1);
    const request: RouteRequest = {
      spells: spells,
      // Only a seed-derived queue can be read back to its raw rows.
      rawSpells: rawSpells,
      goal: goal,
      metamax: metamax,
      currentMagic: current,
      startingRefills: refills,
      // Both selectors gate the button, so a missing pick cannot reach here.
      restrictions: {
        siAllowed: readAvailability(siRadios) === true,
        rbAllowed: readAvailability(rbRadios) === true,
      },
      towerLevel: towerLevel,
      absMaxTowers: towersForMaxMagic(metamax, towerLevel),
      // The instructions number their boxes from here, in the game's own count.
      startCastCount: readNumber(castTotalInput) ?? 0,
    };

    // A second run replaces the one in flight.
    if (running) halt();

    runStartedAt = performance.now();
    latestProgress = null;
    // A new search measures its own throughput from scratch.
    lastSample = null;
    branchRate = 0;
    routeMetamax = metamax;

    const search = worker ?? createSearchWorker();
    worker = search;

    search.onmessage = (event: MessageEvent<RouteWorkerMessage>) => {
      // A terminated search can still have messages in flight; drop them.
      if (worker !== search) return;

      const message = event.data;

      if (message.kind === "progress") {
        latestProgress = message.progress;
        sampleBranchRate(message.progress, message.elapsed);
        renderLiveStats(message.progress, message.elapsed, false);

        return;
      }

      if (message.kind === "polished") {
        const pending = polishResolver;
        polishResolver = null;
        pending?.resolve(message.instructions);

        return;
      }

      setRunning(false);
      liveHost.hidden = true;

      if (message.kind === "result") {
        renderResult(message.result, message.instructions);
      } else {
        renderFailure(message.message, message.elapsed);
      }

      revealResult();
    };

    search.onerror = () => {
      if (worker !== search) return;

      worker = null;
      search.terminate();
      setRunning(false);
      liveHost.hidden = true;
      renderFailure("the search worker failed to start", performance.now() - runStartedAt);
      revealResult();
    };

    setRunning(true);
    renderSearching();
    // The row takes the search's place from the start; it holds dashes until the
    // first report has something real to say.
    renderLiveStats(null, 0, false);
    const message: RouteWorkerRequest = { kind: "route", request };
    search.postMessage(message);
  };

  const halt = (): void => {
    if (!running) return;

    const elapsed = performance.now() - runStartedAt;
    // A worker busy inside the search cannot answer a message, so stopping it
    // is a kill - the next run starts from a fresh worker and its tables.
    worker?.terminate();
    worker = null;
    setRunning(false);

    // The counters stay where they stopped, drained of colour: the search they
    // were describing is over, and the result card says why.
    renderLiveStats(latestProgress, elapsed, true);
    renderHalted(elapsed);
  };

  /**
   * The three linked max-magic fields come off the URL in the game's own terms: a
   * tower count and level define max magic, so that pair wins when both are
   * present; max magic plus a level solves for the tower count; anything partial
   * is written through as-is and left for the player to finish.
   */
  const applyMaxMagicParams = (params: PlannerUrlParams): void => {
    if (params.towerLevel !== null) {
      towerLevelInput.value = String(clampTowerLevel(params.towerLevel));
    }

    if (params.towerCount !== null) {
      towersInput.value = String(clampTowerCount(params.towerCount));
    }

    if (params.maxMagic !== null) {
      maxMagicInput.value = String(Math.max(params.maxMagic, 1));
    }

    if (params.towerCount !== null && params.towerLevel !== null) {
      linkMaxMagic("towers");
    } else if (params.maxMagic !== null && params.towerLevel !== null) {
      linkMaxMagic("maxMagic");
    } else if (params.maxMagic !== null) {
      syncCurrentCap();
    }
  };

  /** Light up the matching button, if the link carries a value for this selector. */
  const applyAvailability = (radios: HTMLInputElement[], value: boolean | null): void => {
    if (value === null) return;

    const picked = radios.find((radio) => (radio.value === "true") === value);

    if (picked) picked.checked = true;
  };

  /**
   * Load the form from the URL: the seed first, because a successful import is
   * what reveals the mandatory fields, then the values those fields carry. When
   * the link asks for it and every required input is present, the search starts
   * on its own. The `execute` switch is intentionally not part of a share link,
   * so opening a shared route never launches a search by surprise.
   */
  const applyUrlParams = (): void => {
    const params = readPlannerUrlParams(window.location.search);

    if (params.lookahead !== null) lookaheadInput.value = String(params.lookahead);

    if (params.seed !== null) importBox.loadSeed(params.seed, params.casts);

    applyMaxMagicParams(params);

    if (params.currentMagic !== null) currentInput.value = String(params.currentMagic);
    syncCurrentCap();

    if (params.refills !== null) {
      const picked = refillsRadios.find(
        (radio) => Number.parseInt(radio.value, 10) === params.refills,
      );

      if (picked) picked.checked = true;
    }

    applyAvailability(siRadios, params.si);
    applyAvailability(rbRadios, params.rb);

    updateRouteAvailability();

    syncLookaheadWarning();

    if (params.execute && routeReady()) run();
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (running) {
      halt();

      return;
    }

    // The button greys out without every input; Enter must be just as strict.
    if (!routeReady()) return;

    run();
  });

  // The box starts by explaining itself, so a fresh page is never a blank card.
  renderIdle();

  // A URL may carry a whole form state; load it last, once every control exists.
  // A link that routes on load replaces the idle note with the search in flight.
  applyUrlParams();

  return section;
}
