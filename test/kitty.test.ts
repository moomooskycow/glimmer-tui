import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { detectRenderMode } from "../src/detect.js";
import {
  encodeKittyPng,
  foregroundForImage,
  placeholderCell,
  placeholderGrid,
} from "../src/kitty.js";
import { encodeSixel } from "../src/sixel.js";

test("unicode placeholders match the kitty 2x2 example", () => {
  assert.equal(foregroundForImage(42), "\x1b[38;5;42m");
  const [first, second] = placeholderGrid(42, 2, 2);
  assert.equal(first, `\x1b[38;5;42m${placeholderCell(0, 0)}${placeholderCell(0, 1)}\x1b[39m`);
  assert.equal(placeholderCell(0, 0), "\u{10EEEE}\u0305\u0305");
  assert.equal(placeholderCell(0, 1), "\u{10EEEE}\u0305\u030D");
  assert.equal(placeholderCell(1, 0), "\u{10EEEE}\u030D\u0305");
  assert.ok(second?.includes(placeholderCell(1, 1)));
  assert.equal(placeholderCell(0, 0, 2), "\u{10EEEE}\u0305\u0305\u030E");
});

test("png transmission creates a virtual placement and no cursor placement", () => {
  const png = PNG.sync.write(new PNG({ width: 2, height: 2 }));
  const encoded = encodeKittyPng(png, { id: 7, cols: 4, rows: 3, mode: "unicode" });
  assert.match(encoded, /\x1b_Ga=t,f=100,t=d,i=7,q=2,/);
  assert.match(encoded, /\x1b_Ga=p,U=1,i=7,c=4,r=3,q=2\x1b\\/);
  assert.equal(encoded.includes("a=T"), false);
});

test("sixel output carries the raster size", () => {
  const image = new PNG({ width: 2, height: 2 });
  image.data.fill(255);
  const encoded = encodeSixel(PNG.sync.write(image));
  assert.match(encoded, /^\x1bPq"1;1;2;2/);
  assert.ok(encoded.endsWith("\x1b\\"));
});

test("render mode follows the terminal environment", () => {
  assert.equal(detectRenderMode({ KITTY_WINDOW_ID: "1" }), "kitty-unicode");
  assert.equal(detectRenderMode({ GHOSTTY_RESOURCES_DIR: "/tmp" }), "kitty-unicode");
  assert.equal(detectRenderMode({ WEZTERM_PANE: "1" }), "kitty-direct");
  assert.equal(detectRenderMode({ TERM: "xterm-256color" }), "text");
  assert.equal(detectRenderMode({ TERM: "xterm-kitty" }, "text"), "text");
});
