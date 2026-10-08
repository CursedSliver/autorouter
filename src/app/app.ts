import { createRoutePlanner } from "../components/route-planner";
import { createUsageGuide } from "../components/usage-guide";
import { query } from "../lib/dom";

/** Where the chosen theme is remembered between visits. */
const THEME_KEY = "metarouter-theme";
type Theme = "dark" | "light";

/** Dark is the default: only an explicit light choice is written to the root. */
const readTheme = (): Theme =>
  document.documentElement.dataset.theme === "light" ? "light" : "dark";

const applyTheme = (theme: Theme): void => {
  if (theme === "light") {
    document.documentElement.dataset.theme = "light";
  } else {
    delete document.documentElement.dataset.theme;
  }

  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be blocked; the theme simply will not persist.
  }
};

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <main class="app">
      <header class="app__header">
        <div class="app__titlebar">
          <h1 class="app__title">Metarouter <span class="app__badge">BETA</span></h1>
          <button class="button" type="button" data-theme-toggle>To: lookasist imitation</button>
        </div>
        <p class="app__subtitle">
          Automatically computes how to perform a combo given an excerpt from <a href="https://plasma4.github.io/FtHoF-Planner-v6" target="_blank">FtHoF Planner v6.1</a>.
        </p>
      </header>
      <div data-guide-host></div>
      <div data-planner-host></div>
      <footer class="app__footer">
        <nav class="app__links" aria-label="Project links">
          <a class="app__link" href="https://github.com/cursedsliver/autorouter#common-questions" target="_blank" rel="noopener noreferrer">Q &amp; A</a>
          <a class="app__link" href="https://github.com/cursedsliver/autorouter#contact" target="_blank" rel="noopener noreferrer">Contact</a>
          <a class="app__link" href="https://github.com/cursedsliver/autorouter#how-does-this-work" target="_blank" rel="noopener noreferrer">How does this work?</a>
          <a class="app__link" href="https://github.com/cursedsliver/autorouter#contribute" target="_blank" rel="noopener noreferrer">Please contribute!</a>
        </nav>
      </footer>
    </main>
  `;

  const themeButton = query<HTMLButtonElement>(root, "[data-theme-toggle]");

  const syncThemeButton = (): void => {
    const theme = readTheme();
    const next = theme === "dark" ? "To lookasist imitation" : "To normal design";

    themeButton.textContent = `${next}`;
    themeButton.setAttribute("aria-label", `Switch ${next}`);
  };

  themeButton.addEventListener("click", () => {
    applyTheme(readTheme() === "dark" ? "light" : "dark");
    syncThemeButton();
  });

  syncThemeButton();

  query<HTMLElement>(root, "[data-guide-host]").append(createUsageGuide());
  query<HTMLElement>(root, "[data-planner-host]").append(createRoutePlanner());
}
