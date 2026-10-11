import assert from "node:assert/strict";
import test from "node:test";
import { InputParser, type InputEvent } from "../src/input.js";

const char = (text: string): InputEvent => ({ type: "key", key: { type: "char", text } });

test("ordinary text, control keys, and Escape keep their existing behavior", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("a🙂\r\n\t\x7f\b\x03\x00"), [
    char("a"), char("🙂"),
    { type: "key", key: { type: "enter" } },
    { type: "key", key: { type: "enter" } },
    { type: "key", key: { type: "tab" } },
    { type: "key", key: { type: "backspace" } },
    { type: "key", key: { type: "backspace" } },
    char("\x03"),
  ]);
  assert.deepEqual(parser.push("\x1b"), []);
  assert.deepEqual(parser.flushEscape(), [{ type: "key", key: { type: "escape" } }]);
  assert.deepEqual(parser.flushEscape(), []);
  assert.deepEqual(parser.push("\x1bx"), [{ type: "key", key: { type: "escape" } }, char("x")]);
});

const supported: Array<[string, InputEvent]> = [
  ["\x1b[A", { type: "key", key: { type: "up" } }],
  ["\x1b[1;2B", { type: "key", key: { type: "down" } }],
  ["\x1b[C", { type: "key", key: { type: "right" } }],
  ["\x1b[D", { type: "key", key: { type: "left" } }],
  ["\x1b[Z", { type: "key", key: { type: "tab", shift: true } }],
  ["\x1b[3~", { type: "key", key: { type: "backspace" } }],
  ["\x1b[<0;12;34M", { type: "mouse", mouse: { type: "down", delta: 0, x: 12, y: 34, button: 0 } }],
  ["\x1b[<0;12;34m", { type: "mouse", mouse: { type: "up", delta: 0, x: 12, y: 34, button: 0 } }],
  ["\x1b[<32;12;34M", { type: "mouse", mouse: { type: "drag", delta: 0, x: 12, y: 34, button: 0 } }],
  ["\x1b[<35;12;34M", { type: "mouse", mouse: { type: "move", delta: 0, x: 12, y: 34, button: 3 } }],
  ["\x1b[<64;12;34M", { type: "mouse", mouse: { type: "scroll", delta: -3, x: 12, y: 34, button: 0 } }],
  ["\x1b[<65;12;34M", { type: "mouse", mouse: { type: "scroll", delta: 3, x: 12, y: 34, button: 1 } }],
];

test("supported CSI keys and mouse reports survive every chunk boundary", () => {
  for (const [sequence, event] of supported) {
    for (let split = 1; split < sequence.length; split++) {
      const parser = new InputParser();
      assert.deepEqual(parser.push(sequence.slice(0, split)), []);
      assert.deepEqual(parser.push(sequence.slice(split) + "x"), [event, char("x")]);
    }
  }
});

const ignored = [
  "\x1b[97:2u", // Kitty keyboard subparameters
  "\x1b[>0;136;0c", // Secondary device attributes
  "\x1b[?1;2c", // Primary device attributes
  "\x1b[1$y", // Intermediate byte in a mode report
  "\x1b[@", // A final byte outside A-Z/a-z/~
  "\x1b[<u", // Kitty keyboard mode response/control
  "\x1b[<0;5M", // Complete but malformed SGR mouse report
  "\x1b[?1A", // Private parameters must not turn into arrow keys
  "\x1b[1$A", // Neither should intermediate bytes
];

test("complete unsupported CSI sequences do not swallow subsequent input", () => {
  for (const sequence of ignored) {
    const parser = new InputParser();
    assert.deepEqual(parser.push(sequence + "x\x03"), [char("x"), char("\x03")], JSON.stringify(sequence));
  }
});

test("unsupported CSI sequences remain buffered only until their final byte", () => {
  for (const sequence of ignored) {
    for (let split = 1; split < sequence.length; split++) {
      const parser = new InputParser();
      assert.deepEqual(parser.push(sequence.slice(0, split)), []);
      assert.deepEqual(parser.push(sequence.slice(split) + "x\x03"), [char("x"), char("\x03")]);
    }
  }
});

test("Ctrl+C interrupts an incomplete CSI sequence without being swallowed", () => {
  for (const prefix of ["\x1b[", "\x1b[12;", "\x1b[<0;12;", "\x1b[?1;", "\x1b[1$"]) {
    const parser = new InputParser();
    assert.deepEqual(parser.push(prefix), []);
    assert.deepEqual(parser.push("\x03x"), [char("\x03"), char("x")]);
  }
});

test("a new escape sequence recovers from an interrupted CSI prefix", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[<0;"), []);
  assert.deepEqual(parser.push("\x1b[A"), [{ type: "key", key: { type: "up" } }]);
  assert.deepEqual(parser.push("x"), [char("x")]);
});

test("invalid CSI bytes do not prevent later Unicode input", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[12;🙂x"), [char("🙂"), char("x")]);
});

test("a parameter after an intermediate byte is malformed, not incomplete", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[1$"), []);
  assert.deepEqual(parser.push("2x\x03"), [char("2"), char("x"), char("\x03")]);
});

test("the Escape timer does not discard an incomplete CSI sequence", () => {
  const parser = new InputParser();
  assert.deepEqual(parser.push("\x1b[<0;"), []);
  assert.deepEqual(parser.flushEscape(), []);
  assert.deepEqual(parser.push("12;34M"), [supported[6]![1]]);
});

test("OSC replies still support both terminators and split input", () => {
  for (const ending of ["\x07", "\x1b\\"]) {
    const sequence = `\x1b]11;rgb:0000/0000/0000${ending}`;
    for (let split = 1; split < sequence.length; split++) {
      const parser = new InputParser();
      assert.deepEqual(parser.push(sequence.slice(0, split)), []);
      assert.deepEqual(parser.push(sequence.slice(split) + "x"), [char("x")]);
    }
  }
});
