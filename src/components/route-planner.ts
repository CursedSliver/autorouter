import type { RouteProgress } from "../app/route/route";
import { query } from "../lib/dom";
import { DEFAULT_SPELLS } from "../lib/spell";
import { createSpellTable } from "./spell-table";
import type { RouteRequest, RouteSnapshot, RouteWorkerMessage } from "./route-worker";

const DEFAULT_METAMAX = 200;
const DEFAULT_GOAL = 1;
const DEFAULT_REFILLS = 2;

const clamp01 = (value: number): number => Math.min(Math.max(value, 0), 1);

const percent = (fraction: number): string => `${(clamp01(fraction) * 100).toFixed(1)}%`;

const seconds = (elapsed: number): string => `${(elapsed / 1000).toFixed(1)} s`;

const branches = (steps: number): string =>
  steps >= 1_000_000 ? `${(steps / 1_000_000).toFixed(1)}M` : steps.toLocaleString("en-US");

/**
 * The banked effects of a result as one string. `bs` stacks, so it carries how
 * many instances landed, while `ef`, `cf` and `clot` are one-shot. The order is
 * fixed: bs -> ef -> cf -> clot, one entry per buff that actually landed.
 */
const finalCombo = (result: RouteSnapshot): string => {
  const combo = [
    result.bs > 0 ? `${result.bs > 1 ? result.bs : ""}BS` : null,
    result.ef ? "EF" : null,
    result.cf ? "CF" : null,
    result.clot ? "CLOT" : null,
  ].filter((buff): buff is string => buff !== null);

  return combo.length > 0 ? combo.join("+") : "none";
};

/**
 * The magic a step leaves behind. GFD resolves can leave a half point behind, so
 * only values that actually have a fraction get a decimal.
 */
const magicLabel = (value: number): string =>
  Number.isInteger(value) ? String(value) : value.toFixed(1);

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
      <div class="planner__toolbar">
        <label class="field">
          <span class="field__label">metamax</span>
          <input class="field__input" type="number" name="metamax" min="1" step="1" max="200" value="${DEFAULT_METAMAX}" />
        </label>
        <label class="field">
          <span class="field__label">current</span>
          <input class="field__input" type="number" name="current" min="1" step="1" max="200" value="${DEFAULT_METAMAX}" />
        </label>
        <label class="field">
          <span class="field__label">max refills</span>
          <input class="field__input" type="number" name="refills" min="0" step="1" max="2" value="${DEFAULT_REFILLS}" />
        </label>
        <label class="field" style="display: none;">
          <span class="field__label">goal</span>
          <input class="field__input" type="number" name="goal" min="0" step="1" value="${DEFAULT_GOAL}" />
        </label>
        <div class="planner__actions">
          <button class="button button--primary" type="submit" data-run>Run route</button>
          <button class="button" type="button" data-action="add">Add spell</button>
          <button class="button" type="button" data-action="reset">Reset</button>
        </div>
      </div>
      <div class="planner__progress" data-progress-host hidden>
        <div
          class="progress"
          role="progressbar"
          aria-label="Estimated search progress"
          aria-valuemin="0"
          aria-valuemax="100"
          aria-valuenow="0"
          data-progress-bar
        >
          <div class="progress__fill" data-progress-fill></div>
        </div>
        <p class="planner__progress-label" data-progress-label></p>
      </div>
      <div data-table-host></div>
      <p class="planner__hint">
        For each row, if an effect exists anywhere inside the row (including if hidden behind backfires),
        check the box. Then, input GFD RS, which stands for GFD random seed.
      </p>
    </form>
    <div class="planner__result" data-result-host aria-live="polite"></div>
    <div class="warning">
      <p class="warning__title">Notes</p>
      <p class="warning__text">AI disclaimer: Core routing logic is handwritten; AI is used in the creation of the UI.</p>
      <p class="warning__text">Performance disclaimer: Limit amount of rows to below 8 to keep the router fast.</p>
    </div>
  `;

  const form = query<HTMLFormElement>(section, "form");
  const tableHost = query<HTMLElement>(section, "[data-table-host]");
  const resultHost = query<HTMLElement>(section, "[data-result-host]");
  const metamaxInput = query<HTMLInputElement>(section, 'input[name="metamax"]');
  const currentInput = query<HTMLInputElement>(section, 'input[name="current"]');
  const refillsInput = query<HTMLInputElement>(section, 'input[name="refills"]');
  const goalInput = query<HTMLInputElement>(section, 'input[name="goal"]');
  const runButton = query<HTMLButtonElement>(section, "[data-run]");
  const progressHost = query<HTMLElement>(section, "[data-progress-host]");
  const progressBar = query<HTMLElement>(section, "[data-progress-bar]");
  const progressFill = query<HTMLElement>(section, "[data-progress-fill]");
  const progressLabel = query<HTMLElement>(section, "[data-progress-label]");

  const table = createSpellTable(DEFAULT_SPELLS);
  tableHost.append(table.element);

  /** The worker, kept between runs so the core's tables are built only once. */
  let worker: Worker | null = null;
  let running = false;
  let runStartedAt = 0;
  /** Last progress report; it is all that survives a halt. */
  let latestProgress: RouteProgress | null = null;

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

  /**
   * Current magic is bounded by the metamax, so the cap travels with that field:
   * the attribute keeps the browser's own validation honest, and `readInteger`
   * clamps whatever is typed past it.
   */
  const syncMagicCap = (): void => {
    const metamax = readInteger(metamaxInput, DEFAULT_METAMAX, 1);
    currentInput.max = String(metamax);

    if (Number.parseInt(currentInput.value, 10) > metamax) {
      currentInput.value = String(metamax);
    }
  };

  metamaxInput.addEventListener("input", syncMagicCap);

  /** One button serves both ends: it starts a search, and stops the one in flight. */
  const setRunning = (next: boolean): void => {
    running = next;
    runButton.classList.toggle("button--primary", !next);
    runButton.classList.toggle("button--halt", next);
    runButton.textContent = next ? "Halt" : "Run route";
    runButton.title = next
      ? "Stop the search; the best score found so far is kept"
      : "Search for the best route";
    runButton.setAttribute("aria-label", next ? "Halt the running search" : "Run the route search");
  };

  const showProgress = (fraction: number, label: string, halted: boolean): void => {
    progressHost.hidden = false;
    progressBar.classList.toggle("progress--halted", halted);
    progressBar.setAttribute("aria-valuenow", String(Math.round(clamp01(fraction) * 100)));
    progressFill.style.width = `${(clamp01(fraction) * 100).toFixed(2)}%`;
    progressLabel.textContent = label;
  };

  const renderProgress = (progress: RouteProgress, elapsed: number): void => {
    showProgress(
      progress.progress,
      `Searching — ≈${percent(progress.progress)} of the estimate · ${branches(progress.steps)} branches · best score ${progress.score} · ${seconds(elapsed)}`,
      false,
    );
  };

  const renderResult = (result: RouteSnapshot): void => {
    const chips = [
      `pending ${result.pending}`,
      `refills ${result.refills}`,
      `${result.elapsed.toFixed(0)} ms`,
    ];

    const steps =
      result.actions.length > 0
        ? result.actions
            .map(
              (step) =>
                `<span class="chain__step">${step.action}<span class="chain__magic">(${magicLabel(step.magic)})</span></span>`,
            )
            .join('<span class="chain__arrow" aria-hidden="true">→</span>')
        : '<span class="chain__empty">No actions taken.</span>';

    resultHost.classList.remove("planner__result--error");
    resultHost.innerHTML = `
      <dl class="metrics">
        <div class="metrics__item metrics__item--score">
          <dt class="metrics__label">Score</dt>
          <dd class="metrics__value">${String(result.score)}</dd>
        </div>
        <div class="metrics__item">
          <dt class="metrics__label">Magic left</dt>
          <dd class="metrics__value">${result.magic}</dd>
        </div>
        <div class="metrics__item metrics__item--combo">
          <dt class="metrics__label">Final combo</dt>
          <dd class="metrics__value">${finalCombo(result)}</dd>
        </div>
      </dl>
      <div class="chain">
        <p class="chain__label">
          <span>Actions taken</span>
          <span class="chain__legend">magic after each action</span>
        </p>
        <div class="chain__steps">${steps}</div>
      </div>
      <div class="planner__footer">
        <ul class="chips">${chips.map((chip) => `<li class="chip">${chip}</li>`).join("")}</ul>
      </div>
    `;
  };

  const renderFailure = (message: string, elapsed: number): void => {
    resultHost.classList.add("planner__result--error");

    const paragraph = document.createElement("p");
    paragraph.className = "planner__error";
    const heading = document.createElement("strong");
    heading.textContent = "route() failed";

    paragraph.append(heading, ` after ${elapsed.toFixed(0)} ms — ${message}`);
    resultHost.replaceChildren(paragraph);
  };

  /** What the result card says while a search is in flight. */
  const renderSearching = (): void => {
    resultHost.classList.remove("planner__result--error");

    const paragraph = document.createElement("p");
    paragraph.className = "planner__note";
    paragraph.textContent =
      "Searching for the best route — the progress bar above tracks the estimate, and the run button halts it.";
    resultHost.replaceChildren(paragraph);
  };

  /** A halted search has no result: only the last report says how far it got. */
  const renderHalted = (elapsed: number): void => {
    resultHost.classList.remove("planner__result--error");

    const paragraph = document.createElement("p");
    paragraph.className = "planner__note planner__note--warn";
    paragraph.textContent = latestProgress
      ? `Halted after ${seconds(elapsed)} at ≈${percent(latestProgress.progress)} of the estimated search. Best score found so far: ${latestProgress.score} — the search did not finish, so a better route may exist.`
      : `Halted after ${seconds(elapsed)}, before the search reported any progress.`;
    resultHost.replaceChildren(paragraph);
  };

  const run = (): void => {
    syncMagicCap();
    const metamax = readInteger(metamaxInput, DEFAULT_METAMAX, 1);
    const refills = readInteger(refillsInput, DEFAULT_REFILLS, 0) as 0 | 1 | 2;
    const current = readInteger(currentInput, metamax, 0, metamax);
    const goal = readInteger(goalInput, DEFAULT_GOAL, 0);
    const spells = table.getSpells();
    const request: RouteRequest = {
      spells: spells,
      goal: goal,
      metamax: metamax,
      currentMagic: current,
      startingRefills: refills,
    };

    // A second run replaces the one in flight.
    if (running) halt();

    runStartedAt = performance.now();
    latestProgress = null;

    const search = worker ?? createSearchWorker();
    worker = search;

    search.onmessage = (event: MessageEvent<RouteWorkerMessage>) => {
      // A terminated search can still have messages in flight; drop them.
      if (worker !== search) return;

      const message = event.data;

      if (message.kind === "progress") {
        latestProgress = message.progress;
        renderProgress(message.progress, message.elapsed);

        return;
      }

      setRunning(false);
      progressHost.hidden = true;

      if (message.kind === "result") {
        renderResult(message.result);
      } else {
        renderFailure(message.message, message.elapsed);
      }
    };

    search.onerror = () => {
      if (worker !== search) return;

      worker = null;
      search.terminate();
      setRunning(false);
      progressHost.hidden = true;
      renderFailure("the search worker failed to start", performance.now() - runStartedAt);
    };

    setRunning(true);
    renderSearching();
    showProgress(0, "Searching — waiting for the first progress report.", false);
    search.postMessage(request);
  };

  const halt = (): void => {
    if (!running) return;

    const elapsed = performance.now() - runStartedAt;
    // A worker busy inside the search cannot answer a message, so stopping it
    // is a kill - the next run starts from a fresh worker and its tables.
    worker?.terminate();
    worker = null;
    setRunning(false);

    showProgress(
      latestProgress?.progress ?? 0,
      latestProgress
        ? `Halted at ≈${percent(latestProgress.progress)} · ${branches(latestProgress.steps)} branches · best score ${latestProgress.score} · ${seconds(elapsed)}`
        : `Halted after ${seconds(elapsed)}.`,
      true,
    );
    renderHalted(elapsed);
  };

  form.addEventListener("submit", (event) => {
    event.preventDefault();

    if (running) {
      halt();
    } else {
      run();
    }
  });

  form.addEventListener("click", (event) => {
    if (!(event.target instanceof Element)) return;

    const action = event.target.closest<HTMLElement>("[data-action]")?.dataset.action;

    if (action === "add") {
      table.appendSpell();
    } else if (action === "reset") {
      table.setSpells(DEFAULT_SPELLS);
      run();
    }
  });

  run();

  return section;
}
