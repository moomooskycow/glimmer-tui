import type { Key } from "./textwidget.js";

export interface MouseEvent {
  type: "down" | "up" | "drag" | "move" | "scroll";
  /** Positive values scroll content downward (wheel down). */
  delta: number;
  x: number;
  y: number;
  button: number;
}

export type InputEvent = { type: "key"; key: Key } | { type: "mouse"; mouse: MouseEvent };

export class InputParser {
  private buffer = "";

  push(text: string): InputEvent[] {
    this.buffer += text;
    const events: InputEvent[] = [];
    while (this.buffer.length > 0) {
      const next = this.take();
      if (next === "wait") break;
      if (next) events.push(next);
    }
    return events;
  }

  flushEscape(): InputEvent[] {
    if (this.buffer === "\x1b") {
      this.buffer = "";
      return [{ type: "key", key: { type: "escape" } }];
    }
    return [];
  }

  private take(): InputEvent | "wait" | null {
    const buffer = this.buffer;
    if (buffer.startsWith("\x1b[")) {
      // Frame every CSI before decoding the small subset we support: parameter
      // bytes (0x30-0x3f), intermediate bytes (0x20-0x2f), then a final byte.
      const match = /^\x1b\[([0-?]*)([ -/]*)([@-~])?/.exec(buffer)!;
      const params = match[1] ?? "";
      const intermediate = match[2] ?? "";
      const final = match[3];
      if (!final) {
        if (match[0].length === buffer.length) return "wait";
        // Discard only the invalid sequence prefix. Reprocess the offending
        // byte so a new Escape sequence or Ctrl+C can still reach the UI.
        this.buffer = buffer.slice(match[0].length);
        return null;
      }
      this.buffer = buffer.slice(match[0].length);
      if (!intermediate && /^<\d+;\d+;\d+$/.test(params) && /^[Mm]$/.test(final)) {
        return { type: "mouse", mouse: decodeSgr(match[0]) };
      }
      if (intermediate || !/^[0-9;]*$/.test(params)) return null;
      const key = decodeCsi(params, final);
      return key ? { type: "key", key } : null;
    }
    if (buffer.startsWith("\x1b]")) {
      const end = buffer.indexOf("\x07");
      const st = buffer.indexOf("\x1b\\");
      const at = end === -1 ? st : st === -1 ? end : Math.min(end, st);
      if (at === -1) return "wait";
      const size = end === at ? 1 : 2;
      this.buffer = buffer.slice(at + size);
      return null;
    }
    if (buffer.startsWith("\x1b")) {
      if (buffer.length === 1) return "wait";
      this.buffer = buffer.slice(1);
      return { type: "key", key: { type: "escape" } };
    }
    const char = [...buffer][0] ?? "";
    this.buffer = buffer.slice(char.length);
    if (char === "\r" || char === "\n") return { type: "key", key: { type: "enter" } };
    if (char === "\x7f" || char === "\b") return { type: "key", key: { type: "backspace" } };
    if (char === "\t") return { type: "key", key: { type: "tab" } };
    if (char === "\x03") return { type: "key", key: { type: "char", text: "\x03" } };
    if (char === "\x1b") return { type: "key", key: { type: "escape" } };
    if (char < " " && char !== " ") return null;
    return { type: "key", key: { type: "char", text: char } };
  }
}

function decodeCsi(params: string, final: string): Key | null {
  if (final === "A") return { type: "up" };
  if (final === "B") return { type: "down" };
  if (final === "C") return { type: "right" };
  if (final === "D") return { type: "left" };
  if (final === "Z") return { type: "tab", shift: true };
  if (final === "~" && params === "3") return { type: "backspace" };
  return null;
}

function decodeSgr(sequence: string): MouseEvent {
  const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(sequence);
  if (!match) return { type: "move", delta: 0, x: 1, y: 1, button: 0 };
  const code = Number(match[1]);
  const x = Number(match[2]);
  const y = Number(match[3]);
  const release = match[4] === "m";
  const wheel = (code & 64) !== 0;
  const motion = (code & 32) !== 0;
  const button = code & 3;
  if (wheel) {
    const down = (code & 1) === 1;
    return { type: "scroll", delta: down ? 3 : -3, x, y, button };
  }
  if (release) return { type: "up", delta: 0, x, y, button };
  if (motion && button === 3) return { type: "move", delta: 0, x, y, button };
  if (motion) return { type: "drag", delta: 0, x, y, button };
  return { type: "down", delta: 0, x, y, button };
}

export function keyToDom(key: Key): { type: "key"; key: string } | { type: "type"; text: string } | null {
  if (key.type === "enter") return { type: "key", key: "Enter" };
  if (key.type === "tab") return { type: "key", key: key.shift ? "Shift+Tab" : "Tab" };
  if (key.type === "backspace") return { type: "key", key: "Backspace" };
  if (key.type === "up") return { type: "key", key: "ArrowUp" };
  if (key.type === "down") return { type: "key", key: "ArrowDown" };
  if (key.type === "left") return { type: "key", key: "ArrowLeft" };
  if (key.type === "right") return { type: "key", key: "ArrowRight" };
  if (key.type === "char" && key.text >= " ") return { type: "type", text: key.text };
  return null;
}
