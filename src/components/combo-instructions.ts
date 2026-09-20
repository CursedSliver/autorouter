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
/** Distance from a box edge to the nearest additional arrow lane. */
const LANE_GAP = 6;
/** Distance between two stacked lanes, so their dashes cannot touch. */
const LANE_SPACING = 8;
/** Room kept beyond the outermost lane, so a line never sits on the border. */
const LANE_MARGIN = 5;
/** Room kept between the two lane groups, on either side of the row rule. */
const LANE_DIVIDER_SEP = 10;
/** Arrowhead size, in pixels. */
const HEAD = 5;
/** Gap left between a default arrow's ends and the boxes it connects. */
const ARROW_INSET = 7;
/** Width used before the panel has been laid out and has a real width. */
const FALLBACK_WIDTH = 960;
/** The colour of the chain of default arrows. */
const DEFAULT_ARROW_COLOR = "#cfe0ff";
/** Lane colours, the first a faded yellow; each lane further out steps down. */
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

/**
 * A run along a row's lane. Two runs only collide when they share the row, the
 * side and the lane, and their x ranges overlap; a lane is what keeps arrows
 * that would otherwise be drawn on top of each other apart.
 */
interface LaneRun {
  row: number;
  side: 0 | 1;
  lane: number;
  x1: number;
  x2: number;
}

/** Where an arrow travels on a side, before its lanes are picked. */
type RouteRun = Omit<LaneRun, "side" | "lane">;

/** An additional arrow, resolved to a lane on every row it crosses. */
interface PlacedArrow {
  runs: LaneRun[];
  /** The x the arrow leaves its source box at. */
  sourceX: number;
  /** The x the arrow meets its target box at. */
  targetX: number;
  color: string;
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
 *
 * An additional arrow pairs a GFD cast with the resolve that completes it and
 * travels in a lane just off the box edges. It takes the nearest lane that is
 * free on every row it crosses, so two arrows sharing a stretch of rows are
 * stacked a step apart instead of drawn over each other, and a row grows taller
 * to hold the lanes it carries. Each arrow goes to the side that crowds it less,
 * then to the side used less often, so above and below stay balanced.
 *
 * With `showAdditional` false the additional arrows are not placed at all and
 * every row collapses to the height it would have without them.
 */
function layout(
  actions: readonly PolishedAction[],
  width: number,
  showAdditional: boolean,
): Layout {
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
  const rightEdge = boardWidth - 2;
  const leftEdge = 2;

  const boxRow = (index: number): number => Math.floor(index / perRow);
  const boxX = (index: number): number => leftPad + (index % perRow) * (BOX_W + gap);

  // Every additional arrow, resolved to a lane on each row it crosses but not
  // yet to a y: the row tops depend on how many lanes the rows end up carrying.
  const placed: PlacedArrow[] = [];
  const sideUsage: [number, number] = [0, 0];

  if (showAdditional) {
    for (let index = 0; index < count; index++) {
      const target = actions[index]!.additionalArrow;

      if (target < 0 || target >= count || target === index) continue;

      const low = Math.min(index, target);
      const high = Math.max(index, target);
      const fromRow = boxRow(low);
      const toRow = boxRow(high);
      const sourceX = boxX(low) + BOX_W / 2;
      const targetX = boxX(high) + BOX_W / 2;

      /** Where an arrow on a side would travel, before its lanes are picked. */
      const routeOn = (): RouteRun[] => {
        if (fromRow === toRow) {
          return [{ row: fromRow, x1: Math.min(sourceX, targetX), x2: Math.max(sourceX, targetX) }];
        }

        const route: RouteRun[] = [
          { row: fromRow, x1: Math.min(sourceX, rightEdge), x2: Math.max(sourceX, rightEdge) },
        ];

        // Cross every row in between, so the arrow always reappears on the row
        // directly below instead of jumping straight to a far-away target row.
        for (let row = fromRow + 1; row < toRow; row++) {
          route.push({ row, x1: leftEdge, x2: rightEdge });
        }

        route.push({
          row: toRow,
          x1: Math.min(leftEdge, targetX),
          x2: Math.max(leftEdge, targetX),
        });

        return route;
      };

      /** The nearest lane on the run's row that no other arrow already holds. */
      const laneFor = (side: 0 | 1, run: RouteRun): number => {
        for (let lane = 0; ; lane++) {
          const taken = placed.some((arrow) =>
            arrow.runs.some(
              (other) =>
                other.row === run.row &&
                other.side === side &&
                other.lane === lane &&
                Math.min(other.x2, run.x2) - Math.max(other.x1, run.x1) > MIN_OVERLAP,
            ),
          );

          if (!taken) return lane;
        }
      };

      const plan = (side: 0 | 1): LaneRun[] =>
        routeOn().map((run) => ({ ...run, side, lane: laneFor(side, run) }));

      const below = plan(0);
      const above = plan(1);
      const crowding = (runs: LaneRun[]): number =>
        runs.reduce((total, run) => total + run.lane, 0);
      const belowCrowding = crowding(below);
      const aboveCrowding = crowding(above);
      // The emptier side wins; on a tie the side used less often, and on a full
      // tie the lane below, which is the more common resolve.
      const side: 0 | 1 =
        belowCrowding < aboveCrowding
          ? 0
          : aboveCrowding < belowCrowding
            ? 1
            : sideUsage[0] <= sideUsage[1]
              ? 0
              : 1;
      const chosen = side === 0 ? below : above;
      const depth = chosen.reduce((deepest, run) => Math.max(deepest, run.lane), 0);

      sideUsage[side] += 1;
      placed.push({
        runs: chosen,
        sourceX,
        targetX,
        // Each lane further out wears the next colour, so a stack stays readable.
        color: LANE_COLORS[depth % LANE_COLORS.length]!,
      });
    }
  }

  // How far a row's lanes reach past its edge, and so how much room the border or
  // the gap beside it has to hold.
  const laneSpan = (lanes: number): number =>
    lanes === 0 ? 0 : LANE_GAP + (lanes - 1) * LANE_SPACING + LANE_MARGIN;

  const lanesAbove = new Array<number>(rows).fill(0);
  const lanesBelow = new Array<number>(rows).fill(0);

  for (const arrow of placed) {
    for (const run of arrow.runs) {
      if (run.side === 0) lanesBelow[run.row] = Math.max(lanesBelow[run.row]!, run.lane + 1);
      else lanesAbove[run.row] = Math.max(lanesAbove[run.row]!, run.lane + 1);
    }
  }

  // Row tops and the rules between them: a gap holds the lanes reaching down from
  // the row above and up from the row below, with the rule kept between them.
  const rowTop: number[] = [];
  const rowBottom: number[] = [];
  const dividers: number[] = [];
  let cursor = PAD + laneSpan(lanesAbove[0]!);

  for (let row = 0; row < rows; row++) {
    rowTop.push(cursor);
    rowBottom.push(cursor + BOX_H);

    if (row + 1 === rows) break;

    const below = laneSpan(lanesBelow[row]!);
    const above = laneSpan(lanesAbove[row + 1]!);
    const between = Math.max(ROW_GAP, below + above + LANE_DIVIDER_SEP);

    dividers.push(cursor + BOX_H + below + (between - below - above) / 2);
    cursor += BOX_H + between;
  }

  const boardHeight = rowBottom[rows - 1]! + laneSpan(lanesBelow[rows - 1]!) + PAD;

  const rowCenter = (row: number): number => rowTop[row]! + BOX_H / 2;
  const laneY = (run: LaneRun): number =>
    run.side === 0
      ? rowBottom[run.row]! + LANE_GAP + run.lane * LANE_SPACING
      : rowTop[run.row]! - LANE_GAP - run.lane * LANE_SPACING;

  const segments: Segment[] = [];
  const labels: Label[] = [];

  // The default chain: one arrow from each action to the next, labelled with the
  // change in tower count when there is one.
  for (let index = 0; index < count - 1; index++) {
    const fromRow = boxRow(index);
    const toRow = boxRow(index + 1);
    const delta = actions[index + 1]!.towerCount - actions[index]!.towerCount;
    const label =
      delta === 0 ? null : `${delta > 0 ? "+" : "-"}${Math.abs(delta).toLocaleString("en-US")}`;

    if (fromRow === toRow) {
      const y = rowCenter(fromRow);
      const x1 = boxX(index) + BOX_W + ARROW_INSET;
      const x2 = boxX(index + 1) - ARROW_INSET;

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

      continue;
    }

    const y = rowCenter(fromRow);
    const nextY = rowCenter(toRow);

    segments.push({
      points: [
        { x: boxX(index) + BOX_W + ARROW_INSET, y },
        { x: rightEdge, y },
      ],
      head: null,
      color: DEFAULT_ARROW_COLOR,
      opacity: 0.85,
    });
    segments.push({
      points: [
        { x: leftEdge, y: nextY },
        { x: boxX(index + 1) - ARROW_INSET, y: nextY },
      ],
      head: { x: boxX(index + 1) - ARROW_INSET, y: nextY },
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

  // Fold each additional arrow's runs into the polylines that draw it, one
  // segment per row so each can sit in its own lane. The runs carry no
  // arrowhead: one would land on a box edge and be clipped by it.
  placed.forEach((arrow, arrowIndex) => {
    const runs = arrow.runs;
    const source = runs[0]!;
    const target = runs[runs.length - 1]!;
    // Shift each arrow's dashes a little, so two lanes next to each other do not
    // march in step and read as one thick line.
    const dashOffset = (arrowIndex * 4) % 11;
    const push = (points: Point[]): void => {
      segments.push({
        points,
        head: null,
        color: arrow.color,
        opacity: 0.55,
        dashed: true,
        dashOffset,
      });
    };

    const sourceEdge = source.side === 0 ? rowBottom[source.row]! : rowTop[source.row]!;

    if (runs.length === 1) {
      const lane = laneY(source);

      push([
        { x: arrow.sourceX, y: sourceEdge },
        { x: arrow.sourceX, y: lane },
        { x: arrow.targetX, y: lane },
        { x: arrow.targetX, y: sourceEdge },
      ]);

      return;
    }

    // Leave the source row at its right edge.
    const sourceLane = laneY(source);

    push([
      { x: arrow.sourceX, y: sourceEdge },
      { x: arrow.sourceX, y: sourceLane },
      { x: rightEdge, y: sourceLane },
    ]);

    for (let index = 1; index < runs.length - 1; index++) {
      const lane = laneY(runs[index]!);

      push([
        { x: leftEdge, y: lane },
        { x: rightEdge, y: lane },
      ]);
    }

    // Enter the target row from the left and reach the target box.
    const targetLane = laneY(target);

    push([
      { x: leftEdge, y: targetLane },
      { x: arrow.targetX, y: targetLane },
      { x: arrow.targetX, y: target.side === 0 ? rowBottom[target.row]! : rowTop[target.row]! },
    ]);
  });

  return {
    width: boardWidth,
    height: boardHeight,
    boxes: actions.map((_, index) => ({ x: boxX(index), y: rowTop[boxRow(index)]! })),
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
      <div class="ci__controls">
        <label class="ci__switch">
          <input class="ci__switch-input" type="checkbox" data-dashed checked />
          <span class="ci__switch-track" aria-hidden="true">
            <span class="ci__switch-thumb"></span>
          </span>
          <span class="ci__switch-text">dashed lines</span>
        </label>
        <label class="ci__level">
          <span class="ci__level-text">tower level:</span>
          <select class="ci__level-select" data-level>${levelOptions}</select>
        </label>
      </div>
    </div>
    <div class="ci__scroll" data-scroll>
      <div class="ci__board" role="list" data-board></div>
    </div>
    <p class="ci__hint">
      Follow the boxes in order. 
      "Resolve GFD" indicates waiting for a GFD cast's selected spell to be casted after casting the GFD.
      <span data-dashed-hint>
      The faded dashed lines indicate that all actions in between two linked boxes
      must be completed in <b>1 second or less</b>.
      </span>
    </p>
  `;

  const comboValue = element.querySelector<HTMLElement>("[data-combo]")!;
  const levelSelect = element.querySelector<HTMLSelectElement>("[data-level]")!;
  const dashedInput = element.querySelector<HTMLInputElement>("[data-dashed]")!;
  const dashedHint = element.querySelector<HTMLElement>("[data-dashed-hint]")!;
  const scroll = element.querySelector<HTMLElement>("[data-scroll]")!;
  const board = element.querySelector<HTMLElement>("[data-board]")!;

  let current: ComboInstructionsData | null = null;
  let lastWidth = -1;
  /** Whether the additional arrows are drawn; off collapses the rows. */
  let showAdditional = dashedInput.checked;

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
    const result = layout(current.actions, width, showAdditional);

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
    dashedHint.hidden = !showAdditional;
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

  // Hiding the additional arrows takes their lanes away with them, so the rows
  // pack back down to the height they have with none.
  dashedInput.addEventListener("change", () => {
    showAdditional = dashedInput.checked;
    dashedHint.hidden = !showAdditional;
    paint();
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
