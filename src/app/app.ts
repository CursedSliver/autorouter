import { createRoutePlanner } from "../components/route-planner";
import { query } from "../lib/dom";

export function mountApp(root: HTMLElement): void {
  root.innerHTML = `
    <main class="app">
      <header class="app__header">
        <p class="app__badge">version 0.1</p>
        <h1 class="app__title">Metarouter</h1>
        <p class="app__subtitle">
          Describe a sequence of <code>Spell</code>s, alongside any limitations you desire, and let it find the best route.
        </p>
      </header>
      <div data-planner-host></div>
    </main>
  `;

  query<HTMLElement>(root, "[data-planner-host]").append(createRoutePlanner());
}
