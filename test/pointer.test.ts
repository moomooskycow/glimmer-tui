import assert from "node:assert/strict";
import test from "node:test";
import { mapPointer } from "../src/pointer.js";

const geo = { cellWidth: 10, cellHeight: 20, dpr: 2 };
const placed = { col: 2, row: 3, cols: 4, rows: 2 };

test("cell pointer maps to the CSS center of the hit cell", () => {
  const hit = mapPointer({ x: 3, y: 4, mode: "cell" }, placed, geo);
  assert.deepEqual(hit, { cssX: 2.5, cssY: 5 });
});

test("pixel pointer uses the same CSS point as the cell center", () => {
  const hit = mapPointer({ x: 26, y: 71, mode: "pixel" }, placed, geo);
  assert.deepEqual(hit, { cssX: 2.5, cssY: 5 });
});

test("pointers outside the bitmap miss", () => {
  assert.equal(mapPointer({ x: 2, y: 4, mode: "cell" }, placed, geo), null);
  assert.equal(mapPointer({ x: 7, y: 4, mode: "cell" }, placed, geo), null);
  assert.equal(mapPointer({ x: 20, y: 71, mode: "pixel" }, placed, geo), null);
});

test("a component scrolled one row off the top still maps the visible cell", () => {
  const scrolled = { ...placed, row: -1 };
  const hit = mapPointer({ x: 3, y: 1, mode: "cell" }, scrolled, geo);
  assert.deepEqual(hit, { cssX: 2.5, cssY: 15 });
});
