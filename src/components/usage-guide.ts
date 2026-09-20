/**
 * The usage guide: the README's own words, folded away just under the title.
 *
 * The text is the README itself, imported at build time (esbuild loads `.md` as
 * a string; see `scripts/build.mjs`), so the guide cannot drift from the
 * document it quotes. Only the part above `# Contact` is shown, and
 * `lib/markdown` turns it into HTML wearing the app's own styles.
 */
import readme from "../../README.md";
import { query } from "../lib/dom";
import { renderMarkdown } from "../lib/markdown";

/** Where the excerpt stops: the README's contact section and everything after it. */
const CONTACT_HEADING = /^#\s+Contact\s*$/m;

/** The README above its `# Contact` heading, or the whole file when it has none. */
const excerpt = (source: string): string => {
  const end = source.search(CONTACT_HEADING);

  return end === -1 ? source : source.slice(0, end);
};

export function createUsageGuide(): HTMLElement {
  const section = document.createElement("section");
  section.className = "usage-guide";
  section.innerHTML = `
    <button
      class="usage-guide__toggle"
      type="button"
      data-toggle-guide
      aria-expanded="false"
      aria-controls="usage-guide-body"
    >
      <span class="usage-guide__title">Usage guide</span>
      <span class="usage-guide__arrow" aria-hidden="true">▾▾</span>
    </button>
    <div class="usage-guide__body" id="usage-guide-body" data-guide-body hidden></div>
  `;

  const body = query<HTMLElement>(section, "[data-guide-body]");
  const toggle = query<HTMLButtonElement>(section, "[data-toggle-guide]");

  // The guide is static text, so it is rendered once, up front.
  body.innerHTML = renderMarkdown(excerpt(readme));

  toggle.addEventListener("click", () => {
    const open = body.hidden;
    body.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
  });

  return section;
}
