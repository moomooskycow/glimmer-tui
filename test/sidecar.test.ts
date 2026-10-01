import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { mapPointer } from "../src/pointer.js";
import { parseSpec } from "../src/spec.js";
import { RendererSidecar } from "../src/sidecar.js";

const cellWidth = 20;
const cellHeight = 40;
const dpr = 2;

test("a mapped click hits the real choice button", async () => {
  const sidecar = await RendererSidecar.launch("dark", dpr);
  try {
    const spec = parseSpec({
      type: "choice",
      id: "ui_hit",
      title: "Which branch?",
      prompt: "Pick one.",
      options: [
        { id: "release/2.4", label: "release/2.4", description: "Stable train" },
        { id: "main", label: "main", description: "Trunk" },
      ],
    });
    const raster = await sidecar.open(spec, {
      cols: 60,
      cellWidth,
      cellHeight,
      dpr,
      maxRows: 30,
    });
    const png = PNG.sync.read(raster.png);
    assert.equal(png.width, raster.cols * cellWidth);
    assert.ok(png.height > 0);

    const box = await sidecar.box(spec.id, '[data-value="main"]');
    assert.ok(box);
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    const placed = { col: 0, row: 0, cols: raster.cols, rows: raster.rows };
    const pointer = {
      x: Math.floor(centerX * dpr / cellWidth) + 1,
      y: Math.floor(centerY * dpr / cellHeight) + 1,
      mode: "cell" as const,
    };
    const mapped = mapPointer(pointer, placed, { cellWidth, cellHeight, dpr });
    assert.ok(mapped);
    assert.ok(mapped.cssX >= box.x && mapped.cssX <= box.x + box.width);
    assert.ok(mapped.cssY >= box.y && mapped.cssY <= box.y + box.height);

    const result = await sidecar.dispatch(spec.id, { type: "click", ...mapped });
    const selected = result.events.find((event) => event.complete);
    assert.ok(selected);
    assert.equal(selected.action, "select");
    assert.equal(selected.value, "main");
    assert.ok(result.png.length > 1000);
  } finally {
    await sidecar.shutdown();
  }
});

test("keyboard navigation on the live page selects the focused choice", async () => {
  const sidecar = await RendererSidecar.launch("light", dpr);
  try {
    const spec = parseSpec({
      type: "choice",
      id: "ui_keys",
      title: "Which branch?",
      options: [
        { id: "release/2.4", label: "release/2.4" },
        { id: "main", label: "main" },
      ],
    });
    await sidecar.open(spec, { cols: 50, cellWidth, cellHeight, dpr, maxRows: 24 });
    await sidecar.dispatch(spec.id, { type: "key", key: "ArrowDown" });
    const result = await sidecar.dispatch(spec.id, { type: "key", key: "Enter" });
    const selected = result.events.find((event) => event.complete);
    assert.equal(selected?.value, "main");
  } finally {
    await sidecar.shutdown();
  }
});
