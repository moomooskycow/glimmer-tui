import { lineDiff } from "./diff.js";
import { presetField } from "./spec.js";
import type { ResolvedSpec, Theme, UiEvent } from "./types.js";

export type Key =
  | { type: "char"; text: string }
  | { type: "enter" }
  | { type: "backspace" }
  | { type: "tab"; shift?: boolean }
  | { type: "escape" }
  | { type: "up" }
  | { type: "down" }
  | { type: "left" }
  | { type: "right" };

export type LineHit =
  | { kind: "option"; index: number }
  | { kind: "field"; index: number }
  | { kind: "approve" }
  | { kind: "reject" }
  | { kind: "row"; index: number }
  | null;

export interface TextRender {
  lines: string[];
  hits: LineHit[];
}

interface Palette {
  dim: string;
  ink: string;
  accent: string;
  warn: string;
  ok: string;
  reset: string;
}

function palette(theme: Theme): Palette {
  if (theme === "light") {
    return {
      dim: "\x1b[38;2;90;82;74m",
      ink: "\x1b[38;2;32;27;23m",
      accent: "\x1b[38;2;15;111;106m",
      warn: "\x1b[38;2;141;45;45m",
      ok: "\x1b[38;2;20;101;58m",
      reset: "\x1b[0m",
    };
  }
  return {
    dim: "\x1b[38;2;164;156;145m",
    ink: "\x1b[38;2;244;239;231m",
    accent: "\x1b[38;2;142;217;209m",
    warn: "\x1b[38;2;243;176;176m",
    ok: "\x1b[38;2;166;224;186m",
    reset: "\x1b[0m",
  };
}

function clip(text: string, width: number): string {
  if (width <= 0) return "";
  let visible = 0;
  let out = "";
  for (let index = 0; index < text.length; ) {
    if (text[index] === "\x1b" && text[index + 1] === "[") {
      const end = text.indexOf("m", index);
      if (end === -1) break;
      out += text.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (visible === width - 1 && visibleLength(text) > width) {
      out += "…\x1b[0m";
      return out;
    }
    out += text[index];
    visible += 1;
    index += 1;
    if (visible === width) return out;
  }
  return out;
}

function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

export class TextWidget {
  cursor = 0;
  fieldIndex = 0;
  fields: Record<string, string> = {};
  frozen = false;
  summary = "";

  constructor(readonly spec: ResolvedSpec) {
    if (spec.type === "form") {
      for (const field of spec.fields) this.fields[field.name] = "";
    }
  }

  render(width: number, theme: Theme): TextRender {
    const spec = this.spec;
    const inner = Math.max(20, width);
    if (this.frozen) {
      return { lines: [clip(this.summary, inner)], hits: [null] };
    }
    const paint = palette(theme);
    const lines: string[] = [];
    const hits: LineHit[] = [];
    const push = (text: string, hit: LineHit = null) => {
      lines.push(clip(text, inner));
      hits.push(hit);
    };
    push(`${paint.accent}${spec.type}${paint.reset}  ${paint.ink}${spec.title ?? spec.type}${paint.reset}`);
    if ("prompt" in spec && spec.prompt) push(`${paint.dim}${spec.prompt}${paint.reset}`);
    if (spec.type === "approval") push(`${paint.dim}${spec.body}${paint.reset}`);

    if (spec.type === "choice") {
      spec.options.forEach((option, index) => {
        const mark = index === this.cursor ? `${paint.accent}▸${paint.reset}` : " ";
        push(
          `${mark} ${index === this.cursor ? paint.ink : paint.dim}${option.label}${paint.reset}`,
          { kind: "option", index },
        );
        if (option.description) {
          push(`  ${paint.dim}${option.description}${paint.reset}`, { kind: "option", index });
        }
      });
      push(`${paint.dim}↑↓ move   enter select${paint.reset}`);
    } else if (spec.type === "form") {
      spec.fields.forEach((field, index) => {
        const active = index === this.fieldIndex;
        const value = this.fields[field.name] ?? "";
        const shown = value || field.placeholder || "";
        const color = value ? paint.ink : paint.dim;
        push(
          `${active ? paint.accent : paint.dim}${field.label}${paint.reset}  ${color}${shown}${active ? "▏" : ""}${paint.reset}`,
          { kind: "field", index },
        );
      });
      push(`${paint.dim}tab next field   enter ${spec.submitLabel ?? "submit"}${paint.reset}`);
    } else if (spec.type === "approval") {
      if (spec.detail) push(`${paint.dim}${spec.detail}${paint.reset}`);
      const approve = this.cursor === 0;
      push(
        `${approve ? paint.ok + "▸ " : "  "}${spec.approveLabel ?? "Approve"}${paint.reset}`,
        { kind: "approve" },
      );
      push(
        `${!approve ? paint.warn + "▸ " : "  "}${spec.rejectLabel ?? "Reject"}${paint.reset}`,
        { kind: "reject" },
      );
      push(`${paint.dim}←→ choose   enter confirm   y/n${paint.reset}`);
    } else if (spec.type === "table") {
      push(`${paint.dim}${spec.columns.map((column) => column.label).join("  ")}${paint.reset}`);
      spec.rows.forEach((row, index) => {
        const mark = spec.selectable && index === this.cursor ? `${paint.accent}▸${paint.reset} ` : "";
        const text = spec.columns.map((column) => String(row[column.key] ?? "")).join("  ");
        push(`${mark}${text}`, spec.selectable ? { kind: "row", index } : null);
      });
    } else if (spec.type === "chart") {
      const max = Math.max(...spec.series.map((point) => point.value), 1);
      for (const point of spec.series) {
        const units = Math.max(1, Math.round((point.value / max) * 16));
        push(
          `${point.label.padEnd(12, " ")} ${paint.accent}${"█".repeat(units)}${paint.dim}${"░".repeat(16 - units)}${paint.reset} ${point.value}`,
        );
      }
    } else if (spec.type === "diff") {
      for (const line of lineDiff(spec.before, spec.after)) {
        if (line.kind === "add") push(`${paint.ok}+ ${line.text}${paint.reset}`);
        else if (line.kind === "del") push(`${paint.warn}- ${line.text}${paint.reset}`);
        else push(`${paint.dim}  ${line.text}${paint.reset}`);
      }
    } else if (spec.type === "html") {
      push(`${paint.dim}custom HTML card${paint.reset}`);
    }
    return { lines, hits };
  }

  handleKey(key: Key): UiEvent | null {
    if (this.frozen) return null;
    const spec = this.spec;
    if (spec.type === "choice") {
      if (key.type === "down") this.cursor = (this.cursor + 1) % spec.options.length;
      else if (key.type === "up") this.cursor = (this.cursor - 1 + spec.options.length) % spec.options.length;
      else if (key.type === "char" && /^[1-9]$/.test(key.text)) {
        const index = Number(key.text) - 1;
        if (spec.options[index]) {
          this.cursor = index;
          return this.event("select", spec.options[index].id);
        }
      } else if (key.type === "enter") {
        const option = spec.options[this.cursor];
        if (option) return this.event("select", option.id);
      }
      return null;
    }
    if (spec.type === "form") {
      const field = spec.fields[this.fieldIndex];
      if (!field) return null;
      if (key.type === "tab") {
        const delta = key.shift ? -1 : 1;
        this.fieldIndex = (this.fieldIndex + delta + spec.fields.length) % spec.fields.length;
      } else if (key.type === "down") {
        this.fieldIndex = Math.min(spec.fields.length - 1, this.fieldIndex + 1);
      } else if (key.type === "up") {
        this.fieldIndex = Math.max(0, this.fieldIndex - 1);
      } else if (key.type === "backspace") {
        const current = this.fields[field.name] ?? "";
        this.fields[field.name] = current.slice(0, -1);
      } else if (key.type === "char") {
        this.fields[field.name] = (this.fields[field.name] ?? "") + key.text;
      } else if (key.type === "enter") {
        return this.event("submit", { ...this.fields });
      }
      return null;
    }
    if (spec.type === "approval") {
      if (key.type === "left" || key.type === "up" || key.type === "char" && key.text.toLowerCase() === "y") {
        this.cursor = 0;
        if (key.type === "char") return this.event("approve", true);
      } else if (key.type === "right" || key.type === "down" || key.type === "char" && key.text.toLowerCase() === "n") {
        this.cursor = 1;
        if (key.type === "char") return this.event("reject", false);
      } else if (key.type === "enter") {
        return this.cursor === 0 ? this.event("approve", true) : this.event("reject", false);
      }
      return null;
    }
    if (spec.type === "table" && spec.selectable) {
      if (key.type === "down") this.cursor = (this.cursor + 1) % spec.rows.length;
      else if (key.type === "up") this.cursor = (this.cursor - 1 + spec.rows.length) % spec.rows.length;
      else if (key.type === "enter") return this.event("select-row", this.cursor);
    }
    return null;
  }

  handleClick(hit: LineHit): UiEvent | null {
    if (this.frozen || !hit) return null;
    if (hit.kind === "option" && this.spec.type === "choice") {
      this.cursor = hit.index;
      const option = this.spec.options[hit.index];
      return option ? this.event("select", option.id) : null;
    }
    if (hit.kind === "field" && this.spec.type === "form") {
      this.fieldIndex = hit.index;
      return null;
    }
    if (hit.kind === "approve") return this.event("approve", true);
    if (hit.kind === "reject") return this.event("reject", false);
    if (hit.kind === "row" && this.spec.type === "table") {
      this.cursor = hit.index;
      return this.event("select-row", hit.index);
    }
    return null;
  }

  freezeWith(event: UiEvent): void {
    this.frozen = true;
    const value =
      typeof event.value === "string" ? event.value : JSON.stringify(event.value);
    this.summary = `${this.spec.title}  →  ${event.action} ${value}`;
  }

  private event(action: string, value: unknown): UiEvent {
    return { componentId: this.spec.id, action, value };
  }
}

export function scriptedEvent(widget: TextWidget): UiEvent {
  const spec = widget.spec;
  if (spec.type === "choice") {
    const event = widget.handleKey({ type: "enter" });
    if (!event) throw new Error("choice did not submit");
    return event;
  }
  if (spec.type === "form") {
    for (let index = 0; index < spec.fields.length; index++) {
      if (index > 0) widget.handleKey({ type: "tab" });
      const field = spec.fields[index];
      if (!field) continue;
      for (const char of presetField(field.name)) {
        widget.handleKey({ type: "char", text: char });
      }
    }
    const event = widget.handleKey({ type: "enter" });
    if (!event) throw new Error("form did not submit");
    return event;
  }
  if (spec.type === "approval") {
    const event = widget.handleKey({ type: "enter" });
    if (!event) throw new Error("approval did not submit");
    return event;
  }
  if (spec.type === "table" && spec.selectable) {
    const event = widget.handleKey({ type: "enter" });
    if (!event) throw new Error("table did not submit");
    return event;
  }
  throw new Error(`no scripted interaction for ${spec.type}`);
}
