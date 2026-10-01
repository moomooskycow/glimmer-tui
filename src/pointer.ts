import type { Geometry } from "./types.js";

export interface PlacedComponent {
  /** 0-based screen column of the bitmap's left edge. */
  col: number;
  /** 0-based screen row of the bitmap's top edge. Negative when scrolled off the top. */
  row: number;
  cols: number;
  rows: number;
}

export interface PointerSample {
  /**
   * 1-based coordinate, matching SGR mouse reports.
   * In cell mode this is a column or row. In pixel mode it is a physical pixel.
   */
  x: number;
  y: number;
  mode: "cell" | "pixel";
}

export interface CssPoint {
  cssX: number;
  cssY: number;
}

/**
 * Map a terminal pointer sample onto the CSS pixel space of a live component page.
 * Playwright mouse events use that same CSS space; the screenshot is `dpr` times larger.
 */
export function mapPointer(
  pointer: PointerSample,
  placed: PlacedComponent,
  geo: Pick<Geometry, "cellWidth" | "cellHeight" | "dpr">,
): CssPoint | null {
  const dpr = geo.dpr || 1;
  let localPx: number;
  let localPy: number;
  if (pointer.mode === "cell") {
    const localCol = pointer.x - 1 - placed.col;
    const localRow = pointer.y - 1 - placed.row;
    if (localCol < 0 || localRow < 0 || localCol >= placed.cols || localRow >= placed.rows) {
      return null;
    }
    localPx = localCol * geo.cellWidth + geo.cellWidth / 2;
    localPy = localRow * geo.cellHeight + geo.cellHeight / 2;
  } else {
    localPx = pointer.x - 1 - placed.col * geo.cellWidth;
    localPy = pointer.y - 1 - placed.row * geo.cellHeight;
    const width = placed.cols * geo.cellWidth;
    const height = placed.rows * geo.cellHeight;
    if (localPx < 0 || localPy < 0 || localPx >= width || localPy >= height) return null;
  }
  return { cssX: localPx / dpr, cssY: localPy / dpr };
}

export function normalizeCell(
  width: number,
  height: number,
): { cellWidth: number; cellHeight: number; dpr: number } {
  let cellWidth = width > 0 ? Math.round(width) : 10;
  let cellHeight = height > 0 ? Math.round(height) : 20;
  let dpr = cellWidth >= 14 ? 1 : 2;
  if (cellWidth % dpr !== 0 || cellHeight % dpr !== 0) dpr = 1;
  return { cellWidth, cellHeight, dpr };
}
