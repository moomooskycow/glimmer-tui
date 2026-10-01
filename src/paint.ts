import { createHash } from "node:crypto";
import { deleteAllImages, encodeKittyPng, placeholderGrid } from "./kitty.js";
import { encodeSixel } from "./sixel.js";
import type { TextWidget, LineHit } from "./textwidget.js";
import type { RenderMode, ResolvedSpec, Theme } from "./types.js";

export interface MessageBlock {
  kind: "message";
  role: "you" | "agent";
  text: string;
}

export interface ComponentBlock {
  kind: "component";
  spec: ResolvedSpec;
  widget: TextWidget;
  png?: Buffer;
  imageId: number;
  cols: number;
  rows: number;
  frozen: boolean;
  hash?: string;
}

export type Block = MessageBlock | ComponentBlock;

export interface Placement {
  id: string;
  col: number;
  row: number;
  cols: number;
  rows: number;
  frozen: boolean;
  hits: LineHit[];
}

export interface Frame {
  bytes: string;
  placements: Placement[];
  scroll: number;
  contentRows: number;
}

export function pngHash(png: Buffer): string {
  return createHash("sha1").update(png).digest("hex");
}

export function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    if (paragraph.length === 0) {
      lines.push("");
      continue;
    }
    let rest = paragraph;
    while (rest.length > width) {
      let cut = rest.lastIndexOf(" ", width);
      if (cut < 8) cut = width;
      lines.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    lines.push(rest);
  }
  return lines;
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function fit(text: string, width: number): string {
  const plain = stripAnsi(text);
  if (plain.length > width) return plain.slice(0, width);
  return text + " ".repeat(width - plain.length);
}

const RESET = "\x1b[0m";

function tint(theme: Theme, role: "you" | "agent" | "dim" | "accent"): string {
  if (theme === "light") {
    if (role === "you") return "\x1b[38;2;90;82;74m";
    if (role === "agent") return "\x1b[38;2;15;111;106m";
    if (role === "accent") return "\x1b[38;2;15;111;106m";
    return "\x1b[38;2;120;112;102m";
  }
  if (role === "you") return "\x1b[38;2;176;168;156m";
  if (role === "agent" || role === "accent") return "\x1b[38;2;142;217;209m";
  return "\x1b[38;2;140;132;122m";
}

interface LaidText {
  kind: "text";
  text: string;
  id?: string;
  hit: LineHit;
  hitIndex: number;
  hitCount: number;
}

interface LaidImage {
  kind: "image";
  block: ComponentBlock;
  imageRow: number;
}

type Laid = LaidText | LaidImage;

function layout(blocks: readonly Block[], cols: number, mode: RenderMode, theme: Theme): Laid[] {
  const lines: Laid[] = [];
  const width = Math.max(10, cols - 2);
  for (const block of blocks) {
    if (block.kind === "message") {
      lines.push({
        kind: "text",
        text: `${tint(theme, block.role)}${block.role}${RESET}`,
        hit: null,
        hitIndex: 0,
        hitCount: 0,
      });
      for (const line of wrapText(block.text, width)) {
        lines.push({
          kind: "text",
          text: `  ${line}`,
          hit: null,
          hitIndex: 0,
          hitCount: 0,
        });
      }
      lines.push({ kind: "text", text: "", hit: null, hitIndex: 0, hitCount: 0 });
      continue;
    }
    const graphic = mode !== "text" && block.png;
    if (!graphic) {
      const rendered = block.widget.render(width, theme);
      rendered.lines.forEach((line, index) => {
        lines.push({
          kind: "text",
          text: `  ${line}`,
          id: block.spec.id,
          hit: rendered.hits[index] ?? null,
          hitIndex: index,
          hitCount: rendered.lines.length,
        });
      });
      lines.push({ kind: "text", text: "", hit: null, hitIndex: 0, hitCount: 0 });
      continue;
    }
    lines.push({
      kind: "text",
      text: `  ${tint(theme, "dim")}${block.spec.type} · ${block.spec.title}${RESET}`,
      hit: null,
      hitIndex: 0,
      hitCount: 0,
    });
    for (let row = 0; row < block.rows; row++) {
      lines.push({ kind: "image", block, imageRow: row });
    }
    lines.push({ kind: "text", text: "", hit: null, hitIndex: 0, hitCount: 0 });
  }
  return lines;
}

export function renderScreen(opts: {
  blocks: readonly Block[];
  cols: number;
  rows: number;
  scroll: number;
  stick: boolean;
  composer: string;
  cursor: number;
  focus: string;
  mode: RenderMode;
  theme: Theme;
  status: string;
  modelName: string;
  tmux: boolean;
  sent: Map<number, string>;
}): Frame {
  const { cols, rows, mode, theme } = opts;
  const bodyHeight = Math.max(1, rows - 3);
  const laid = layout(opts.blocks, cols, mode, theme);
  const maxScroll = Math.max(0, laid.length - bodyHeight);
  const scroll = opts.stick ? maxScroll : Math.min(Math.max(0, opts.scroll), maxScroll);
  const visible = laid.slice(scroll, scroll + bodyHeight);
  const placements: Placement[] = [];
  const indent = 2;

  let bytes = "\x1b[?2026h";
  if (mode === "kitty-direct") bytes += deleteAllImages(opts.tmux);

  if (mode === "kitty-unicode") {
    const seen = new Set<number>();
    for (const line of visible) {
      if (line.kind !== "image" || seen.has(line.block.imageId) || !line.block.png) continue;
      seen.add(line.block.imageId);
      const hash = `${line.block.hash ?? ""}:${line.block.cols}x${line.block.rows}`;
      if (opts.sent.get(line.block.imageId) === hash) continue;
      bytes += encodeKittyPng(line.block.png, {
        id: line.block.imageId,
        cols: line.block.cols,
        rows: line.block.rows,
        mode: "unicode",
        tmux: opts.tmux,
      });
      opts.sent.set(line.block.imageId, hash);
    }
  }

  const header = `${tint(theme, "accent")}glimmer${RESET}  ${opts.modelName}  ${mode}  ${theme}  ${tint(theme, "dim")}${opts.status}${RESET}`;
  bytes += `\x1b[1;1H\x1b[2K${fit(header, cols)}`;

  const imageOrigins = new Map<number, number>();
  for (let index = 0; index < visible.length; index++) {
    const line = visible[index];
    const screenRow = index + 2;
    if (!line) {
      bytes += `\x1b[${screenRow};1H\x1b[2K`;
      continue;
    }
    if (line.kind === "text") {
      bytes += `\x1b[${screenRow};1H\x1b[2K${fit(line.text, cols)}`;
      if (line.id) {
        let placement = placements.find((item) => item.id === line.id);
        if (!placement) {
          placement = {
            id: line.id,
            col: 0,
            row: screenRow - 1 - line.hitIndex,
            cols,
            rows: line.hitCount,
            frozen: false,
            hits: Array.from({ length: line.hitCount }, () => null),
          };
          placements.push(placement);
        }
        placement.hits[line.hitIndex] = line.hit;
      }
      continue;
    }
    if (!imageOrigins.has(line.block.imageId)) imageOrigins.set(line.block.imageId, screenRow);
    if (mode === "kitty-unicode") {
      const grid = placeholderGrid(line.block.imageId, line.block.cols, line.block.rows);
      const row = grid[line.imageRow] ?? "";
      bytes += `\x1b[${screenRow};1H\x1b[2K${" ".repeat(indent)}${row}`;
    } else {
      bytes += `\x1b[${screenRow};1H\x1b[2K`;
    }
  }

  for (const [imageId, screenRow] of imageOrigins) {
    const line = visible.find((item) => item.kind === "image" && item.block.imageId === imageId);
    if (!line || line.kind !== "image" || !line.block.png) continue;
    placements.push({
      id: line.block.spec.id,
      col: indent,
      row: screenRow - 1 - line.imageRow,
      cols: line.block.cols,
      rows: line.block.rows,
      frozen: line.block.frozen,
      hits: [],
    });
    if (line.imageRow !== 0) continue;
    if (mode === "kitty-direct") {
      bytes += `\x1b[${screenRow};${indent + 1}H${encodeKittyPng(line.block.png, {
        id: imageId,
        cols: line.block.cols,
        rows: line.block.rows,
        mode: "direct",
        tmux: opts.tmux,
      })}`;
    } else if (mode === "sixel") {
      bytes += `\x1b[${screenRow};${indent + 1}H${encodeSixel(line.block.png)}`;
    }
  }

  const rule = `${tint(theme, "dim")}${"─".repeat(cols)}${RESET}`;
  const prefix = focusHint(opts.focus);
  const composer = `${prefix}${opts.composer}`;
  bytes += `\x1b[${rows - 1};1H\x1b[2K${fit(rule, cols)}`;
  bytes += `\x1b[${rows};1H\x1b[2K${fit(composer, cols)}`;
  if (opts.focus === "composer") {
    const column = Math.min(cols, prefix.length + opts.cursor + 1);
    bytes += `\x1b[${rows};${column}H\x1b[?25h`;
  } else {
    bytes += "\x1b[?25l";
  }
  bytes += "\x1b[?2026l";
  return { bytes, placements, scroll, contentRows: laid.length };
}

function focusHint(focus: string): string {
  return focus === "composer" ? "› " : "· ";
}

export function renderLinear(opts: {
  blocks: readonly Block[];
  cols: number;
  mode: RenderMode;
  theme: Theme;
  tmux: boolean;
}): string {
  const laid = layout(opts.blocks, opts.cols, opts.mode, opts.theme);
  let out = "";
  const seen = new Set<number>();
  for (const line of laid) {
    if (line.kind === "text") {
      out += `${line.text}\n`;
      continue;
    }
    if (!line.block.png) continue;
    if (line.imageRow === 0 && !seen.has(line.block.imageId)) {
      seen.add(line.block.imageId);
      if (opts.mode === "kitty-unicode" || opts.mode === "kitty-direct") {
        out += encodeKittyPng(line.block.png, {
          id: line.block.imageId,
          cols: line.block.cols,
          rows: line.block.rows,
          mode: opts.mode === "kitty-direct" ? "direct" : "unicode",
          tmux: opts.tmux,
        });
      } else if (opts.mode === "sixel") {
        out += encodeSixel(line.block.png);
      }
    }
    if (opts.mode === "kitty-unicode") {
      const grid = placeholderGrid(line.block.imageId, line.block.cols, line.block.rows);
      out += `${grid[line.imageRow] ?? ""}\n`;
    } else if (line.imageRow === 0 && opts.mode === "text") {
      out += `[${line.block.spec.type} ${line.block.spec.title}]\n`;
    } else if (opts.mode === "kitty-direct" || opts.mode === "sixel") {
      if (line.imageRow > 0) out += "\n";
    }
  }
  return out;
}
