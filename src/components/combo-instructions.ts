/**
 * The combo-instructions panel: the polished route drawn as boxes of actions
 * joined by arrows, so a player can follow the sequence rather than read a list.
 *
 * The panel is pure layout: the route core (and `polish`) runs in the worker, and
 * this file only needs the flattened `ComboInstructionsData`. Because `polish`
 * bakes the assumed tower level into every tower count, changing the level means
 * asking the worker to re-polish; the panel exposes `setTowerLevel` for that.
 *
 * Geometry is computed analytically from a fixed box size and the panel's own
 * width, so there is nothing to measure after the boxes are placed and arrows can
 * be drawn in the same pass.
 */
import type { ComboInstructionsData, PolishedAction } from "../app/route/polish";
import { MAX_TOWER_LEVEL, MIN_TOWER_LEVEL } from "../lib/max-magic";

const SVG_NS = "http://www.w3.org/2000/svg";

/** Fixed box metrics: equal for every action, so rows pack predictably. */
const BOX_W = 160;
const BOX_H = 44;
/** The gap between boxes in a row: grown to fill the row, within these bounds. */
const MIN_BOX_GAP = 38;
const MAX_BOX_GAP = 78;
/** Vertical room between rows, enough for a label and the arrow lanes. */
const ROW_GAP = 40;
/** Board padding, so an arrow near the top or bottom edge has room to be seen. */
const PAD = 14;
/**
 * Room kept at the left and right edges of the board for the wrap-around arrows
 * and their labels, so neither is clipped by the panel border.
 */
const SIDE_ROOM = 46;
/** Distance from a box edge to an additional arrow's lane. */
const LANE_GAP = 6;
/** Arrowhead size, in pixels. */
const HEAD = 5;
/** Gap left between a default arrow's ends and the boxes it connects. */
const ARROW_INSET = 7;
/** Width used before the panel has been laid out and has a real width. */
const FALLBACK_WIDTH = 960;
/** The colour of the chain of default arrows. */
const DEFAULT_ARROW_COLOR = "#cfe0ff";
/** Lane colours, the first a faded yellow; overlapping arrows step down the list. */
const LANE_COLORS = ["#ffd500", "#ff8f3f", "#ff5d8f", "#4dd4ff", "#8bff6b", "#c08bff"];
/** How far two runs must overlap before they count as sharing a lane. */
const MIN_OVERLAP = 3;
/** How far above an arrow its tower-count change sits. */
const LABEL_LIFT = 7;

interface Point {
  x: number;
  y: number;
}

/** A horizontal arrow that also carries a label. */
interface Label {
  x: number;
  y: number;
  text: string;
  color: string;
  anchor: "middle" | "end";
}

/** A polyline ending, optionally, in an arrowhead. */
interface Segment {
  points: Point[];
  head: Point | null;
  color: string;
  opacity: number;
  /** Dashed lanes are the additional arrows; the default chain is solid. */
  dashed?: boolean;
  /** Phase shift for the dashes, so two stacked lanes both stay visible. */
  dashOffset?: number;
}

/** A run along a row's lane, used to tell when two additional arrows collide. */
interface LaneRun {
  row: number;
  side: 0 | 1;
  x1: number;
  x2: number;
}

interface Layout {
  width: number;
  height: number;
  boxes: Point[];
  dividers: number[];
  segments: Segment[];
  labels: Label[];
}

export interface ComboInstructionsOptions {
  /** Ask the worker to re-polish the last route at a tower level. */
  requestPolish: (towerLevel: number) => Promise<ComboInstructionsData>;
}

export interface ComboInstructions {
  readonly element: HTMLElement;
  /** Paint a set of polished instructions. */
  render(data: ComboInstructionsData): void;
  /** Re-polish the route for a different tower level and repaint it. */
  setTowerLevel(level: number): void;
}

const round = (value: number): number => Math.round(value * 100) / 100;

const clampLevel = (level: number): number =>
  Math.min(Math.max(Math.round(level) || MIN_TOWER_LEVEL, MIN_TOWER_LEVEL), MAX_TOWER_LEVEL);

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

/** The same colour at the given alpha, or a neutral fallback if it cannot be read. */
function withAlpha(color: string, alpha: number): string {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());

  if (!match) return `rgba(232, 236, 248, ${alpha})`;

  let hex = match[1]!;
  if (hex.length === 3) hex = hex.split("").map((part) => part + part).join("");

  const value = Number.parseInt(hex, 16);
  const red = (value >> 16) & 0xff;
  const green = (value >> 8) & 0xff;
  const blue = value & 0xff;

  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

/**
 * Place every box and draw the arrows between them.
 *
 * Boxes are laid out left to right, wrapping into a new row when the next one no
 * longer fits, so the rows are a pure function of the available width. The gap
 * between boxes grows to fill the row, which is what gives the arrows room to be
 * read. Arrows between boxes on the same row are horizontal; an arrow whose
 * target is on the next row leaves the board's right edge and re-enters at the
 * left of the next row, keeping only the head at the target.
 */
function layout(actions: readonly PolishedAction[], width: number): Layout {
  const count = actions.length;
  const usable = Math.max(width - SIDE_ROOM * 2, BOX_W);
  const perRow = Math.max(1, Math.floor((usable + MIN_BOX_GAP) / (BOX_W + MIN_BOX_GAP)));
  const gap =
    perRow > 1
      ? Math.min(MAX_BOX_GAP, Math.max(MIN_BOX_GAP, (usable - perRow * BOX_W) / (perRow - 1)))
      : 0;
  const contentWidth = perRow * BOX_W + (perRow - 1) * gap;
  const leftPad = Math.max(SIDE_ROOM, (width - contentWidth) / 2);
  const rows = Math.max(1, Math.ceil(count / perRow));
  const boardWidth = Math.max(width, contentWidth + SIDE_ROOM * 2);
  const boardHeight = PAD * 2 + rows * BOX_H + (rows - 1) * ROW_GAP;
  const rightEdge = boardWidth - 2;
  const leftEdge = 2;

  const boxAt = (index: number): Point & { row: number } => {
    const row = Math.floor(index / perRow);
    const column = index % perRow;

    return { x: leftPad + column * (BOX_W + gap), y: PAD + row * (BOX_H + ROW_GAP), row };
  };

  const rowTop = (row: number): number => PAD + row * (BOX_H + ROW_GAP);
  const rowBottom = (row: number): number => rowTop(row) + BOX_H;
  const rowCenter = (row: number): number => rowTop(row) + BOX_H / 2;

  const segments: Segment[] = [];
  const labels: Label[] = [];
  const dividers: number[] = [];

  for (let row = 0; row < rows - 1; row++) {
    dividers.push(rowBottom(row) + ROW_GAP / 2);
  }

  // The default chain: one arrow from each action to the next, labelled with the
  // change in tower count when there is one.
  for (let index = 0; index < count - 1; index++) {
    const from = boxAt(index);
    const to = boxAt(index + 1);
    const delta = actions[index + 1]!.towerCount - actions[index]!.towerCount;
    const label =
      delta === 0 ? null : `${delta > 0 ? "+" : "-"}${Math.abs(delta).toLocaleString("en-US")}`;

    if (from.row === to.row) {
      const y = rowCenter(from.row);
      const x1 = from.x + BOX_W + ARROW_INSET;
      const x2 = to.x - ARROW_INSET;

      segments.push({
        points: [
          { x: x1, y },
          { x: x2, y },
        ],
        head: { x: x2, y },
        color: DEFAULT_ARROW_COLOR,
        opacity: 0.85,
      });

      if (label) {
        labels.push({
          x: (x1 + x2) / 2,
          y: y - LABEL_LIFT,
          text: label,
          color: DEFAULT_ARROW_COLOR,
          anchor: "middle",
        });
      }
    } else {
      const y = rowCenter(from.row);
      const nextY = rowCenter(to.row);

      segments.push({
        points: [
          { x: from.x + BOX_W + ARROW_INSET, y },
          { x: rightEdge, y },
        ],
        head: null,
        color: DEFAULT_ARROW_COLOR,
        opacity: 0.85,
      });
      segments.push({
        points: [
          { x: leftEdge, y: nextY },
          { x: to.x - ARROW_INSET, y: nextY },
        ],
        head: { x: to.x - ARROW_INSET, y: nextY },
        color: DEFAULT_ARROW_COLOR,
        opacity: 0.85,
      });

      if (label) {
        // Anchor to the board edge so a long count cannot spill out of the panel.
        labels.push({
          x: rightEdge - 4,
          y: y - LABEL_LIFT,
          text: label,
          color: DEFAULT_ARROW_COLOR,
          anchor: "end",
        });
      }
    }
  }

  // The additional arrows. Each pairs a GFD cast with the resolve that completes
  // it; the pair is drawn in sequence order, whichever end stored the reference,
  // so the arrowhead always lands on the later action. Each chooses the side that
  // collides with the fewest arrows already placed; when it still collides, it
  // borrows a contrasting colour so the tangle stays readable.
  const placed: { runs: LaneRun[]; color: string }[] = [];

  for (let index = 0; index < count; index++) {
    const target = actions[index]!.additionalArrow;

    if (target < 0 || target >= count || target === index) continue;

    const from = boxAt(Math.min(index, target));
    const to = boxAt(Math.max(index, target));
    const sourceX = from.x + BOX_W / 2;
    const targetX = to.x + BOX_W / 2;

    const build = (side: 0 | 1): { runs: LaneRun[]; segments: Segment[] } => {
      const runs: LaneRun[] = [];
      const built: Segment[] = [];
      /** The y the arrow travels at on a given row, just off its box edge. */
      const laneAt = (row: number): number =>
        side === 0 ? rowBottom(row) + LANE_GAP : rowTop(row) - LANE_GAP;
      const sourceEdge = side === 0 ? rowBottom(from.row) : rowTop(from.row);

      if (from.row === to.row) {
        runs.push({
          row: from.row,
          side,
          x1: Math.min(sourceX, targetX),
          x2: Math.max(sourceX, targetX),
        });
        // No arrowhead: one would sit on the box edge and be clipped by it.
        built.push({
          points: [
            { x: sourceX, y: sourceEdge },
            { x: sourceX, y: laneAt(from.row) },
            { x: targetX, y: laneAt(from.row) },
            { x: targetX, y: sourceEdge },
          ],
          head: null,
          color: "",
          opacity: 0.55,
        });
      } else {
        const targetEdge = side === 0 ? rowBottom(to.row) : rowTop(to.row);

        // Leave the source row at its right edge.
        runs.push({
          row: from.row,
          side,
          x1: Math.min(sourceX, rightEdge),
          x2: Math.max(sourceX, rightEdge),
        });
        built.push({
          points: [
            { x: sourceX, y: sourceEdge },
            { x: sourceX, y: laneAt(from.row) },
            { x: rightEdge, y: laneAt(from.row) },
          ],
          head: null,
          color: "",
          opacity: 0.55,
        });

        // Cross every row in between, so the arrow always reappears on the row
        // directly below instead of jumping straight to a far-away target row.
        for (let row = from.row + 1; row < to.row; row++) {
          runs.push({ row, side, x1: leftEdge, x2: rightEdge });
          built.push({
            points: [
              { x: leftEdge, y: laneAt(row) },
              { x: rightEdge, y: laneAt(row) },
            ],
            head: null,
            color: "",
            opacity: 0.55,
          });
        }

        // Enter the target row from the left and reach the target box.
        runs.push({
          row: to.row,
          side,
          x1: Math.min(leftEdge, targetX),
          x2: Math.max(leftEdge, targetX),
        });
        built.push({
          points: [
            { x: leftEdge, y: laneAt(to.row) },
            { x: targetX, y: laneAt(to.row) },
            { x: targetX, y: targetEdge },
          ],
          head: null,
          color: "",
          opacity: 0.55,
        });
      }

      return { runs, segments: built };
    };

    const overlapping = (runs: LaneRun[]): number[] => {
      const hits: number[] = [];

      placed.forEach((other, otherIndex) => {
        const collides = other.runs.some((a) =>
          runs.some(
            (b) =>
              a.row === b.row &&
              a.side === b.side &&
              Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1) > MIN_OVERLAP,
          ),
        );

        if (collides) hits.push(otherIndex);
      });

      return hits;
    };

    const below = build(0);
    const above = build(1);
    const belowHits = overlapping(below.runs);
    const aboveHits = overlapping(above.runs);
    // An arrow whose target is on a lower row wants to leave the bottom of its
    // box, so the above lane carries a small penalty: it only wins when it is
    // clearly less crowded, never on a tie. Ties keep the arrow below, which is
    // the more common resolve.
    const abovePenalty = from.row === to.row ? 0 : 1;
    const chosen = belowHits.length <= aboveHits.length + abovePenalty ? below : above;
    const hits = chosen === below ? belowHits : aboveHits;

    let color = LANE_COLORS[0]!;

    if (hits.length > 0) {
      const taken = new Set(hits.map((hit) => placed[hit]!.color));
      color =
        LANE_COLORS.find((candidate) => !taken.has(candidate)) ??
        LANE_COLORS[hits.length % LANE_COLORS.length]!;
    }

    // Shift each lane's dashes a little, so two arrows sharing a lane interleave
    // instead of one drawing exactly over the other.
    const dashOffset = (placed.length * 4) % 11;

    for (const segment of chosen.segments) {
      segment.color = color;
      segment.dashed = true;
      segment.dashOffset = dashOffset;
      segments.push(segment);
    }

    placed.push({ runs: chosen.runs, color });
  }

  return {
    width: boardWidth,
    height: boardHeight,
    boxes: actions.map((_, index) => boxAt(index)),
    dividers,
    segments,
    labels,
  };
}

/** The arrowhead that caps a segment, as a small triangle at the segment's end. */
function headMarkup(tip: Point, from: Point, color: string, opacity: number): string {
  const angle = Math.atan2(tip.y - from.y, tip.x - from.x);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const left = { x: tip.x - HEAD * cos - HEAD * sin, y: tip.y - HEAD * sin + HEAD * cos };
  const right = { x: tip.x - HEAD * cos + HEAD * sin, y: tip.y - HEAD * sin - HEAD * cos };

  return (
    `<path class="ci__head" d="M ${round(tip.x)} ${round(tip.y)} ` +
    `L ${round(left.x)} ${round(left.y)} L ${round(right.x)} ${round(right.y)} Z" ` +
    `style="fill:${color};fill-opacity:${opacity}" />`
  );
}

function arrowMarkup(segment: Segment): string {
  const path = segment.points
    .map((point, index) => `${index === 0 ? "M" : "L"} ${round(point.x)} ${round(point.y)}`)
    .join(" ");
  const offset = segment.dashOffset ? `;stroke-dashoffset:${segment.dashOffset}` : "";
  const className = segment.dashed ? "ci__arrow ci__arrow--dashed" : "ci__arrow";
  const line = `<path class="${className}" d="${path}" style="stroke:${segment.color};stroke-opacity:${segment.opacity}${offset}" />`;
  const last = segment.points[segment.points.length - 1];

  if (segment.head && last) {
    return line + headMarkup(segment.head, last, segment.color, segment.opacity);
  }

  return line;
}

export function createComboInstructions(options: ComboInstructionsOptions): ComboInstructions {
  const element = document.createElement("div");
  element.className = "ci";

  const levelOptions = Array.from({ length: MAX_TOWER_LEVEL - MIN_TOWER_LEVEL + 1 }, (_, i) => {
    const level = MIN_TOWER_LEVEL + i;

    return `<option value="${level}">${level}</option>`;
  }).join("");

  element.innerHTML = `
    <div class="ci__header">
      <span class="ci__combo-value" data-combo>none</span>
      <label class="ci__level">
        <span class="ci__level-text">tower level:</span>
        <select class="ci__level-select" data-level>${levelOptions}</select>
      </label>
    </div>
    <div class="ci__scroll" data-scroll>
      <div class="ci__board" role="list" data-board></div>
    </div>
    <p class="ci__hint">
      Follow the boxes in order. 
      "Resolve GFD" indicates waiting for a GFD cast's selected spell to be casted after casting the GFD.
      The faded dashed lines indicate that all actions in between two linked boxes
      must be completed in <b>1 second or less</b>.
    </p>
  `;

  const comboValue = element.querySelector<HTMLElement>("[data-combo]")!;
  const levelSelect = element.querySelector<HTMLSelectElement>("[data-level]")!;
  const scroll = element.querySelector<HTMLElement>("[data-scroll]")!;
  const board = element.querySelector<HTMLElement>("[data-board]")!;

  let current: ComboInstructionsData | null = null;
  let lastWidth = -1;

  const paint = (): void => {
    if (current === null) return;

    if (current.actions.length === 0) {
      board.style.width = "";
      board.style.height = "";
      board.replaceChildren();
      const empty = document.createElement("p");
      empty.className = "ci__empty";
      empty.textContent = "No actions were taken.";
      board.append(empty);

      return;
    }

    // The wrapper has no padding, so its width is the board's available width.
    const width = scroll.clientWidth > 0 ? scroll.clientWidth : FALLBACK_WIDTH;
    const result = layout(current.actions, width);

    lastWidth = width;
    board.style.width = `${result.width}px`;
    board.style.height = `${result.height}px`;
    board.replaceChildren();

    result.boxes.forEach((box, index) => {
      const action = current!.actions[index]!;
      const boxElement = document.createElement("div");
      boxElement.className = "ci__box";
      boxElement.style.left = `${round(box.x)}px`;
      boxElement.style.top = `${round(box.y)}px`;
      boxElement.style.width = `${BOX_W}px`;
      boxElement.style.height = `${BOX_H}px`;
      boxElement.style.borderColor = action.color;
      boxElement.style.backgroundColor = withAlpha(action.color, 0.3);
      boxElement.setAttribute("role", "listitem");
      boxElement.setAttribute(
        "aria-label",
        `${action.name}, at ${action.towerCount.toLocaleString("en-US")} towers`,
      );
      boxElement.title = `${action.raw} — max magic ${action.maxMagic.toLocaleString("en-US")}`;
      boxElement.innerHTML = action.html;
      board.append(boxElement);
    });

    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("class", "ci__arrows");
    svg.setAttribute("viewBox", `0 0 ${result.width} ${result.height}`);
    svg.setAttribute("width", String(result.width));
    svg.setAttribute("height", String(result.height));
    svg.setAttribute("aria-hidden", "true");

    const markup: string[] = result.dividers.map(
      (y) =>
        `<line class="ci__divider" x1="0" y1="${round(y)}" x2="${result.width}" y2="${round(y)}" />`,
    );

    for (const segment of result.segments) markup.push(arrowMarkup(segment));

    for (const label of result.labels) {
      markup.push(
        `<text class="ci__delta" x="${round(label.x)}" y="${round(label.y)}" ` +
          `text-anchor="${label.anchor}" style="fill:${label.color}">${escapeHtml(label.text)}</text>`,
      );
    }

    svg.innerHTML = markup.join("");
    board.append(svg);
  };

  const render = (data: ComboInstructionsData): void => {
    current = data;
    comboValue.textContent = data.combo;
    levelSelect.value = String(clampLevel(data.towerLevel));
    paint();
  };

  const setTowerLevel = (level: number): void => {
    const next = clampLevel(level);
    levelSelect.value = String(next);

    void options
      .requestPolish(next)
      .then((data) => {
        render(data);
      })
      .catch(() => {
        // No worker to re-polish with: keep the instructions already on screen.
      });
  };

  levelSelect.addEventListener("change", () => {
    setTowerLevel(Number.parseInt(levelSelect.value, 10));
  });

  // Repack the boxes when the panel changes width: the rows are a function of it.
  if (typeof ResizeObserver !== "undefined") {
    const observer = new ResizeObserver(() => {
      if (scroll.clientWidth !== lastWidth) paint();
    });
    observer.observe(scroll);
  }

  return { element, render, setTowerLevel };
}
