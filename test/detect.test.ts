import assert from "node:assert/strict";
import test from "node:test";
import { da1SupportsSixel, detectRenderMode, termIndicatesFoot, wantsSixelProbe } from "../src/detect.js";
import { InputParser } from "../src/input.js";
import { queryTerminal, readTerminalReplies, TERMINAL_PROBE_MS } from "../src/tui.js";

test("foot's TERM selects sixel without a flag or a DA1 reply", () => {
  assert.equal(termIndicatesFoot({ TERM: "foot" }), true);
  assert.equal(termIndicatesFoot({ TERM: "foot-extra" }), true);
  assert.equal(termIndicatesFoot({ TERM: "xterm-256color" }), false);
  assert.equal(detectRenderMode({ TERM: "foot" }), "sixel");
  assert.equal(detectRenderMode({ TERM: "foot-extra" }), "sixel");
  assert.equal(detectRenderMode({ TERM: "foot" }, "text"), "text");
  assert.equal(wantsSixelProbe({ TERM: "foot" }), false);
  assert.equal(wantsSixelProbe({ TERM: "xterm-256color" }), true);
  assert.equal(wantsSixelProbe({ TERM: "xterm-256color" }, "sixel"), false);
});

test("DA1 attribute 4 selects sixel and does not override kitty or wezterm", () => {
  assert.equal(da1SupportsSixel("\x1b[?62;4;22c"), true);
  assert.equal(da1SupportsSixel("\x1b[?64;4;22c"), true);
  assert.equal(da1SupportsSixel("\x1b[?64;1;6;15;22c"), false);
  assert.equal(da1SupportsSixel("\x1b[6;4;4t"), false);
  assert.equal(da1SupportsSixel("\x1b[?1;2c\x1b[?62;4;22c"), true);
  assert.equal(detectRenderMode({ TERM: "xterm-256color" }, undefined, true), "sixel");
  assert.equal(detectRenderMode({ TERM: "xterm-256color" }, undefined, false), "text");
  assert.equal(detectRenderMode({ KITTY_WINDOW_ID: "1", TERM: "foot" }, undefined, true), "kitty-unicode");
  assert.equal(detectRenderMode({ WEZTERM_PANE: "1" }, undefined, true), "kitty-direct");
  assert.equal(detectRenderMode({ GHOSTTY_RESOURCES_DIR: "/tmp" }, undefined, true), "kitty-unicode");
});

test("terminal replies parse cell size, theme, and sixel from one buffer", () => {
  const replies = readTerminalReplies(
    "\x1b[6;18;9t\x1b]11;rgb:2828/2828/2828\x1b\\\x1b[?62;4;22c",
  );
  assert.equal(replies.cellWidth, 9);
  assert.equal(replies.cellHeight, 18);
  assert.equal(replies.theme, "dark");
  assert.equal(replies.sixel, true);
  assert.equal(replies.sawPrimaryDa, true);

  const noSixel = readTerminalReplies("\x1b[6;4;4t\x1b]11;rgb:eeee/eeee/eeee\x07\x1b[?1;2c");
  assert.equal(noSixel.cellWidth, 4);
  assert.equal(noSixel.sixel, false);
  assert.equal(noSixel.theme, "light");
  assert.ok(TERMINAL_PROBE_MS <= 80);
});

test("a non-tty probe returns without waiting", async () => {
  if (process.stdin.isTTY) return;
  const started = Date.now();
  const info = await queryTerminal({ sixel: true });
  assert.equal(info.sixel, false);
  assert.equal(info.cellWidth, 0);
  assert.ok(Date.now() - started < 40);
});

test("DA1 and cell-size replies are not typed as keys", () => {
  const parser = new InputParser();
  const events = parser.push("\x1b[?62;4;22c\x1b[6;18;9t\x1b[<0;8;5M\x1b[<0;8;5ma");
  assert.equal(events.length, 3);
  assert.equal(events[0]?.type, "mouse");
  assert.equal(events[1]?.type, "mouse");
  assert.equal(events[2]?.type, "key");
  if (events[0]?.type === "mouse") {
    assert.equal(events[0].mouse.type, "down");
    assert.equal(events[0].mouse.x, 8);
    assert.equal(events[0].mouse.y, 5);
  }
  if (events[1]?.type === "mouse") assert.equal(events[1].mouse.type, "up");
  if (events[2]?.type === "key" && events[2].key.type === "char") assert.equal(events[2].key.text, "a");
});
