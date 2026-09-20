import { createRoutePlanner } from "../components/route-planner";
import { createUsageGuide } from "../components/usage-guide";
import { query } from "../lib/dom";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <main class="app">
      <header class="app__header">
        <h1 class="app__title">Metarouter <p class="app__badge">1.0</p></h1>
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

  query<HTMLElement>(root, "[data-guide-host]").append(createUsageGuide());
  query<HTMLElement>(root, "[data-planner-host]").append(createRoutePlanner());
}
