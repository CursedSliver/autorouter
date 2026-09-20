/**
 * A deliberately small slice of Markdown: ATX headings, paragraphs, ordered and
 * unordered lists, blockquotes, and the inline quartet of code, links, bold and
 * italics. That is exactly what the project's own README writes, and the usage
 * guide quotes that README verbatim, so the renderer only has to understand the
 * syntax the document actually uses.
 *
 * The source is treated as text, never as HTML: everything is escaped before any
 * markup is added, so a stray `<` in the document cannot become a tag.
 */

/** Escapes the three characters that would otherwise open a tag or an entity. */
const escapeHtml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Inline spans, applied in nesting order: code first because its contents are
 * literal, then links, then the two emphasis forms.
 */
const inline = (text: string): string =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    )
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/gm, "$1<em>$2</em>");

const HEADING = /^(#{1,6})\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const NUMBERED = /^\d+\.\s+(.*)$/;

/** Renders the subset above as HTML, handling the input as text throughout. */
export function renderMarkdown(source: string): string {
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: "ul" | "ol" | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;

    // The README never hard-wraps its prose, so a newline inside a block is one
    // the author asked for: the FAQ's "Q:" and "A:" lines rely on it.
    blocks.push(`<p>${paragraph.map(inline).join("<br />")}</p>`);
    paragraph = [];
  };

  const flushQuote = (): void => {
    if (quote.length === 0) return;

    blocks.push(`<blockquote><p>${quote.map(inline).join("<br />")}</p></blockquote>`);
    quote = [];
  };

  const closeList = (): void => {
    if (list === null) return;

    blocks.push(`</${list}>`);
    list = null;
  };

  /** Starts a list, ending the other kind first: a `-` after a `1.` is a new list. */
  const openList = (kind: "ul" | "ol"): void => {
    if (list === kind) return;

    closeList();
    blocks.push(`<${kind}>`);
    list = kind;
  };

  /** Ends whatever block is open. Every block ends at a blank line or a heading. */
  const closeBlocks = (): void => {
    flushParagraph();
    flushQuote();
    closeList();
  };

  for (const line of source.replace(/\r\n?/g, "\n").split("\n")) {
    const text = line.trim();

    if (text.length === 0) {
      closeBlocks();

      continue;
    }

    const heading = HEADING.exec(text);

    if (heading) {
      closeBlocks();
      const level = (heading[1] ?? "").length;
      blocks.push(`<h${level}>${inline(heading[2] ?? "")}</h${level}>`);

      continue;
    }

    const quoted = QUOTE.exec(text);

    if (quoted) {
      flushParagraph();
      closeList();
      quote.push(quoted[1] ?? "");

      continue;
    }

    const bulleted = BULLET.exec(text);

    if (bulleted) {
      flushParagraph();
      flushQuote();
      openList("ul");
      blocks.push(`<li>${inline(bulleted[1] ?? "")}</li>`);

      continue;
    }

    const numbered = NUMBERED.exec(text);

    if (numbered) {
      flushParagraph();
      flushQuote();
      openList("ol");
      blocks.push(`<li>${inline(numbered[1] ?? "")}</li>`);

      continue;
    }

    flushQuote();
    closeList();
    paragraph.push(text);
  }

  closeBlocks();

  return blocks.join("\n");
}
