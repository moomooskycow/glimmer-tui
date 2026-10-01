import { da1SupportsSixel } from "./detect.js";
import { InputParser, keyToDom, type MouseEvent } from "./input.js";
import { runLoopUntilIdle, type View } from "./loop.js";
import { OPENING_USER, SYSTEM_PROMPT, type Model } from "./model.js";
import { mapPointer } from "./pointer.js";
import { normalizeCell } from "./pointer.js";
import { resamplePng } from "./sixel.js";
import {
  pngHash,
  renderLinear,
  renderScreen,
  type Block,
  type ComponentBlock,
  type Placement,
} from "./paint.js";
import { Session } from "./session.js";
import { scriptedEvent, TextWidget, type Key } from "./textwidget.js";
import type { Renderer, RenderMode, ResolvedSpec, Theme, UiEvent } from "./types.js";

export interface TuiOptions {
  model: Model;
  mode: RenderMode;
  theme: Theme;
  script: boolean;
  scriptDelay: number;
  mouse: "cell" | "pixel";
  tmux: boolean;
  renderer?: Renderer | null;
  geometry?: { cols: number; rows: number; cellWidth: number; cellHeight: number; dpr: number };
}

export async function runInteractive(opts: TuiOptions): Promise<Session> {
  const session = new Session(SYSTEM_PROMPT, OPENING_USER);
  const app = new TerminalApp(opts, session);
  await app.start();
  return session;
}

class TerminalApp {
  private blocks: Block[] = [];
  private scroll = 0;
  private stick = true;
  private composer = "";
  private cursor = 0;
  private focus = "composer";
  private status = "starting";
  private parser = new InputParser();
  private pending = new Map<string, (event: UiEvent) => void>();
  private sent = new Map<number, string>();
  private placements: Placement[] = [];
  private imageIds = 1;
  private cols: number;
  private rows: number;
  private cellWidth: number;
  private cellHeight: number;
  private dpr: number;
  private closed = false;
  private hoverTimer: NodeJS.Timeout | null = null;
  private chain: Promise<void> = Promise.resolve();
  private pumping = false;
  private queue: string[] = [];
  private onData: ((chunk: Buffer) => void) | null = null;
  private onResize: (() => void) | null = null;

  constructor(
    private readonly opts: TuiOptions,
    private readonly session: Session,
  ) {
    if (opts.geometry) {
      this.cols = opts.geometry.cols;
      this.rows = opts.geometry.rows;
      this.cellWidth = opts.geometry.cellWidth;
      this.cellHeight = opts.geometry.cellHeight;
      this.dpr = opts.geometry.dpr;
    } else {
      const size = readSize();
      const cell = normalizeCell(size.cellWidth, size.cellHeight);
      this.cols = size.cols;
      this.rows = size.rows;
      this.cellWidth = cell.cellWidth;
      this.cellHeight = cell.cellHeight;
      this.dpr = cell.dpr;
    }
  }

  async start(): Promise<void> {
    this.enter();
    this.blocks.push({ kind: "message", role: "you", text: OPENING_USER });
    this.paint();
    this.queue.push(OPENING_USER);
    try {
      await this.pump();
      if (this.closed) return;
      if (this.opts.script) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(600, this.opts.scriptDelay)));
        await this.leave(true);
        return;
      }
      await new Promise<void>((resolve) => {
        this.quit = resolve;
      });
      await this.leave(true);
    } catch (error) {
      await this.leave(false);
      throw error;
    }
  }

  private quit: () => void = () => {};

  private enter(): void {
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    const mouse = this.opts.mouse === "pixel" ? "\x1b[?1016h" : "";
    const sixel = this.opts.mode === "sixel" ? "\x1b[?80l" : "";
    process.stdout.write(`\x1b[?1049h${sixel}\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h${mouse}\x1b[?25l`);
    this.onData = (chunk) => {
      const events = this.parser.push(chunk.toString("utf8"));
      for (const event of events) this.enqueue(() => this.handle(event));
    };
    process.stdin.on("data", this.onData);
    const escapeTimer = setInterval(() => {
      for (const event of this.parser.flushEscape()) this.enqueue(() => this.handle(event));
    }, 30);
    this.escapeTimer = escapeTimer;
    this.onResize = () => {
      this.enqueue(() => this.applyResize());
    };
    process.on("SIGWINCH", this.onResize);
  }

  private escapeTimer: NodeJS.Timeout | null = null;

  private async leave(dump: boolean): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.escapeTimer) clearInterval(this.escapeTimer);
    if (this.hoverTimer) clearTimeout(this.hoverTimer);
    if (this.onResize) process.off("SIGWINCH", this.onResize);
    if (this.onData) process.stdin.off("data", this.onData);
    const mouse = this.opts.mouse === "pixel" ? "\x1b[?1016l" : "";
    process.stdout.write(`\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l${mouse}\x1b[?25h\x1b[?1049l`);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    if (dump) {
      process.stdout.write(
        renderLinear({
          blocks: this.blocks,
          cols: this.cols,
          mode: this.opts.mode,
          theme: this.opts.theme,
          tmux: this.opts.tmux,
        }),
      );
      process.stdout.write("\n");
    }
    await this.opts.renderer?.shutdown();
  }

  private enqueue(fn: () => Promise<void> | void): void {
    this.chain = this.chain.then(() => fn()).catch((error: unknown) => {
      this.status = error instanceof Error ? error.message : String(error);
      this.paint();
    });
  }

  private view(): View {
    return {
      assistant: (text) => {
        this.blocks.push({ kind: "message", role: "agent", text });
        this.stick = true;
        this.paint();
      },
      user: (text) => {
        if (this.blocks.some((block) => block.kind === "message" && block.role === "you" && block.text === text)) {
          return;
        }
        this.blocks.push({ kind: "message", role: "you", text });
        this.stick = true;
        this.paint();
      },
      show: (spec) => this.show(spec),
      wait: (spec) => this.wait(spec),
      status: (text) => {
        this.status = text;
        this.paint();
      },
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
        const text = this.queue.shift();
        if (!text) continue;
        if (text !== OPENING_USER) this.session.addUserText(text);
        await runLoopUntilIdle(this.session, this.opts.model, this.view());
      }
    } finally {
      this.pumping = false;
      this.status = "ready";
      this.paint();
    }
  }

  private async show(spec: ResolvedSpec): Promise<void> {
    const widget = new TextWidget(spec);
    const block: ComponentBlock = {
      kind: "component",
      spec,
      widget,
      imageId: this.imageIds++,
      cols: Math.max(24, Math.min(72, this.cols - 4)),
      rows: widget.render(Math.max(24, this.cols - 4), this.opts.theme).lines.length,
      frozen: false,
    };
    if (this.opts.renderer && this.opts.mode !== "text") {
      const raster = await this.opts.renderer.open(spec, {
        cols: block.cols,
        cellWidth: this.cellWidth,
        cellHeight: this.cellHeight,
        dpr: this.dpr,
        maxRows: Math.max(4, this.rows - 6),
      });
      block.png = raster.png;
      block.cols = raster.cols;
      block.rows = raster.rows;
      block.hash = pngHash(raster.png);
    }
    this.blocks.push(block);
    this.stick = true;
    if (spec.wait && !this.opts.script) this.focus = spec.id;
    this.paint();
  }

  private async wait(spec: ResolvedSpec): Promise<UiEvent> {
    const block = this.component(spec.id);
    if (this.opts.script) {
      if (this.opts.scriptDelay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.opts.scriptDelay));
      }
      const event = await this.scripted(block);
      this.freeze(block, event);
      return event;
    }
    this.focus = spec.id;
    this.paint();
    const event = await new Promise<UiEvent>((resolve) => this.pending.set(spec.id, resolve));
    this.freeze(block, event);
    return event;
  }

  private async scripted(block: ComponentBlock): Promise<UiEvent> {
    if (this.opts.renderer && this.opts.mode !== "text") {
      const played = await this.opts.renderer.play(block.spec);
      block.png = played.png;
      block.hash = pngHash(played.png);
      const dom = played.events.find((item) => item.complete) ?? played.events[0];
      if (!dom) throw new Error(`script produced no event for ${block.spec.id}`);
      return { componentId: block.spec.id, action: dom.action, value: dom.value };
    }
    return scriptedEvent(block.widget);
  }

  private freeze(block: ComponentBlock, event: UiEvent): void {
    block.widget.freezeWith(event);
    block.frozen = true;
    this.pending.delete(block.spec.id);
    if (this.focus === block.spec.id) this.focus = "composer";
    this.paint();
    void this.opts.renderer?.close(block.spec.id);
  }

  private async handle(event: { type: "key"; key: Key } | { type: "mouse"; mouse: MouseEvent }): Promise<void> {
    if (event.type === "key" && event.key.type === "char" && event.key.text === "\x03") {
      await this.leave(false);
      process.exit(130);
    }
    if (event.type === "mouse") {
      await this.handleMouse(event.mouse);
      return;
    }
    const key = event.key;
    if (this.focus !== "composer") {
      const block = this.component(this.focus);
      if (key.type === "escape") {
        this.focus = "composer";
        this.paint();
        return;
      }
      if (block.frozen) return;
      if (this.opts.renderer && this.opts.mode !== "text") {
        const dom = keyToDom(key);
        if (!dom) return;
        const result = await this.opts.renderer.dispatch(block.spec.id, dom);
        this.applyRaster(block, result.png, result.events);
        return;
      }
      const ui = block.widget.handleKey(key);
      this.paint();
      if (ui) this.pending.get(block.spec.id)?.(ui);
      return;
    }
    if (key.type === "char" && key.text >= " ") {
      this.composer = this.composer.slice(0, this.cursor) + key.text + this.composer.slice(this.cursor);
      this.cursor += key.text.length;
    } else if (key.type === "backspace" && this.cursor > 0) {
      this.composer = this.composer.slice(0, this.cursor - 1) + this.composer.slice(this.cursor);
      this.cursor -= 1;
    } else if (key.type === "left") this.cursor = Math.max(0, this.cursor - 1);
    else if (key.type === "right") this.cursor = Math.min(this.composer.length, this.cursor + 1);
    else if (key.type === "up") {
      this.stick = false;
      this.scroll = Math.max(0, this.scroll - 1);
    } else if (key.type === "down") this.scroll += 1;
    else if (key.type === "enter" && this.composer.trim()) {
      const text = this.composer.trim();
      this.composer = "";
      this.cursor = 0;
      this.blocks.push({ kind: "message", role: "you", text });
      this.queue.push(text);
      void this.pump();
    }
    this.paint();
  }

  private async handleMouse(mouse: MouseEvent): Promise<void> {
    if (mouse.type === "scroll") {
      const hit = this.placementAt(mouse.x, mouse.y);
      if (hit && !hit.frozen && this.opts.renderer && this.opts.mode !== "text") {
        const point = mapPointer(
          { x: mouse.x, y: mouse.y, mode: this.opts.mouse },
          hit,
          this.geo(),
        );
        if (point) {
          const block = this.component(hit.id);
          const result = await this.opts.renderer.dispatch(hit.id, {
            type: "wheel",
            cssX: point.cssX,
            cssY: point.cssY,
            deltaY: mouse.delta * 40,
          });
          this.applyRaster(block, result.png, result.events);
          return;
        }
      }
      this.stick = false;
      this.scroll += mouse.delta > 0 ? 3 : -3;
      this.paint();
      return;
    }
    if (mouse.type === "move" && this.opts.mode !== "text" && this.opts.renderer) {
      if (this.hoverTimer) clearTimeout(this.hoverTimer);
      this.hoverTimer = setTimeout(() => {
        this.enqueue(() => this.hover(mouse));
      }, 40);
      return;
    }
    if (mouse.type !== "up" && mouse.type !== "down") return;
    const hit = this.placementAt(mouse.x, mouse.y);
    if (!hit || hit.frozen) {
      if (mouse.type === "up") {
        this.focus = "composer";
        this.paint();
      }
      return;
    }
    this.focus = hit.id;
    const block = this.component(hit.id);
    if (this.opts.mode === "text" || !this.opts.renderer) {
      if (mouse.type !== "up") return;
      const local = mouse.y - 1 - hit.row;
      const ui = block.widget.handleClick(hit.hits[local] ?? null);
      this.paint();
      if (ui) this.pending.get(hit.id)?.(ui);
      return;
    }
    const point = mapPointer({ x: mouse.x, y: mouse.y, mode: this.opts.mouse }, hit, this.geo());
    if (!point || mouse.type !== "up") return;
    const result = await this.opts.renderer.dispatch(hit.id, { type: "click", ...point });
    this.applyRaster(block, result.png, result.events);
  }

  private async hover(mouse: MouseEvent): Promise<void> {
    const hit = this.placementAt(mouse.x, mouse.y);
    if (!hit || hit.frozen || !this.opts.renderer) return;
    const point = mapPointer({ x: mouse.x, y: mouse.y, mode: this.opts.mouse }, hit, this.geo());
    if (!point) return;
    const block = this.component(hit.id);
    const result = await this.opts.renderer.dispatch(hit.id, { type: "move", ...point });
    if (result.events.length === 0) {
      block.png = result.png;
      block.hash = pngHash(result.png);
      this.paint();
    } else {
      this.applyRaster(block, result.png, result.events);
    }
  }

  private applyRaster(block: ComponentBlock, png: Buffer, events: { action: string; value: unknown; complete: boolean }[]): void {
    block.png = png;
    block.hash = pngHash(png);
    this.paint();
    const done = events.find((event) => event.complete);
    if (!done) return;
    this.pending.get(block.spec.id)?.({
      componentId: block.spec.id,
      action: done.action,
      value: done.value,
    });
  }

  private placementAt(x: number, y: number): Placement | undefined {
    const row = this.opts.mouse === "pixel" ? Math.floor((y - 1) / this.cellHeight) : y - 1;
    const col = this.opts.mouse === "pixel" ? Math.floor((x - 1) / this.cellWidth) : x - 1;
    return this.placements.find(
      (placement) =>
        row >= placement.row &&
        row < placement.row + placement.rows &&
        col >= placement.col &&
        col < placement.col + placement.cols,
    );
  }

  private component(id: string): ComponentBlock {
    const block = this.blocks.find((item) => item.kind === "component" && item.spec.id === id);
    if (!block || block.kind !== "component") throw new Error(`missing component ${id}`);
    return block;
  }

  private geo() {
    return { cellWidth: this.cellWidth, cellHeight: this.cellHeight, dpr: this.dpr };
  }

  private detachInput(): void {
    if (this.onData) process.stdin.off("data", this.onData);
  }

  private attachInput(): void {
    if (this.onData) process.stdin.on("data", this.onData);
  }

  private async applyResize(): Promise<void> {
    if (this.closed) return;
    this.cols = process.stdout.columns || this.cols;
    this.rows = process.stdout.rows || this.rows;
    if (process.stdin.isTTY) {
      this.detachInput();
      try {
        const probed = await queryTerminal({ sixel: false, timeoutMs: TERMINAL_PROBE_MS });
        if (probed.cellWidth > 0 && probed.cellHeight > 0) {
          this.cellWidth = probed.cellWidth;
          this.cellHeight = probed.cellHeight;
        }
      } finally {
        this.attachInput();
      }
    }
    await this.refitBlocks();
    this.sent.clear();
    this.paint();
  }

  private async refitBlocks(): Promise<void> {
    if (!this.opts.renderer || this.opts.mode === "text") return;
    const cols = Math.max(24, Math.min(72, this.cols - 4));
    for (const block of this.blocks) {
      if (block.kind !== "component" || !block.png) continue;
      if (!block.frozen) {
        try {
          const raster = await this.opts.renderer.refit(block.spec.id, {
            cols,
            cellWidth: this.cellWidth,
            cellHeight: this.cellHeight,
            dpr: this.dpr,
            maxRows: Math.max(4, this.rows - 6),
          });
          block.png = raster.png;
          block.cols = raster.cols;
          block.rows = raster.rows;
          block.hash = pngHash(raster.png);
          continue;
        } catch {
          // The live page is already closed. Fall through and rescale the bitmap.
        }
      }
      const next = resamplePng(block.png, block.cols * this.cellWidth, block.rows * this.cellHeight);
      if (next !== block.png) {
        block.png = next;
        block.hash = pngHash(next);
      }
    }
  }

  private paint(): void {
    if (this.closed) return;
    const frame = renderScreen({
      blocks: this.blocks,
      cols: this.cols,
      rows: this.rows,
      scroll: this.scroll,
      stick: this.stick,
      composer: this.composer,
      cursor: this.cursor,
      focus: this.focus,
      mode: this.opts.mode,
      theme: this.opts.theme,
      status: this.status,
      modelName: this.opts.model.name,
      tmux: this.opts.tmux,
      sent: this.sent,
    });
    this.scroll = frame.scroll;
    if (this.scroll >= Math.max(0, frame.contentRows - Math.max(1, this.rows - 3))) this.stick = true;
    this.placements = frame.placements;
    process.stdout.write(frame.bytes);
  }
}

function readSize(): { cols: number; rows: number; cellWidth: number; cellHeight: number } {
  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  return { cols, rows, cellWidth: 10, cellHeight: 20 };
}

/** One shared probe window. Stacking per-query timers made every terminal wait twice. */
export const TERMINAL_PROBE_MS = 80;

export interface TerminalInfo {
  cellWidth: number;
  cellHeight: number;
  theme: Theme | null;
  sixel: boolean;
}

export interface TerminalReplies {
  cellWidth: number;
  cellHeight: number;
  theme: Theme | null;
  sixel: boolean;
  sawPrimaryDa: boolean;
  sawCell: boolean;
  sawTheme: boolean;
}

export function readTerminalReplies(buffer: string): TerminalReplies {
  const cell = /\x1b\[6;(\d+);(\d+)t/.exec(buffer);
  const background = /rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/.exec(buffer);
  let theme: Theme | null = null;
  if (background) {
    const channel = (hex: string) => parseInt(hex.slice(0, 2), 16);
    const red = channel(background[1] ?? "00");
    const green = channel(background[2] ?? "00");
    const blue = channel(background[3] ?? "00");
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    theme = luminance < 140 ? "dark" : "light";
  }
  return {
    cellWidth: cell ? Number(cell[2]) : 0,
    cellHeight: cell ? Number(cell[1]) : 0,
    theme,
    sixel: da1SupportsSixel(buffer),
    sawPrimaryDa: /\x1b\[\?[0-9;]*c/.test(buffer),
    sawCell: Boolean(cell),
    sawTheme: Boolean(background),
  };
}

export async function queryTerminal(opts?: { sixel?: boolean; timeoutMs?: number }): Promise<TerminalInfo> {
  const empty = { cellWidth: 0, cellHeight: 0, theme: null, sixel: false };
  if (!process.stdin.isTTY) return empty;
  const wantSixel = opts?.sixel ?? false;
  const timeoutMs = opts?.timeoutMs ?? TERMINAL_PROBE_MS;
  process.stdin.setRawMode?.(true);
  return new Promise((resolve) => {
    let buffer = "";
    const finish = (info: TerminalInfo) => {
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve(info);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString("latin1");
      const replies = readTerminalReplies(buffer);
      const sixelDone = !wantSixel || replies.sawPrimaryDa;
      if (replies.sawCell && replies.sawTheme && sixelDone) {
        finish({
          cellWidth: replies.cellWidth,
          cellHeight: replies.cellHeight,
          theme: replies.theme,
          sixel: wantSixel && replies.sixel,
        });
      }
    };
    const timer = setTimeout(() => {
      const replies = readTerminalReplies(buffer);
      finish({
        cellWidth: replies.cellWidth,
        cellHeight: replies.cellHeight,
        theme: replies.theme,
        sixel: wantSixel && replies.sixel,
      });
    }, timeoutMs);
    process.stdin.on("data", onData);
    const da1 = wantSixel ? "\x1b[c" : "";
    process.stdout.write(`\x1b[16t\x1b]11;?\x1b\\${da1}`);
  });
}

export async function queryTerminalGeometry(): Promise<{
  cellWidth: number;
  cellHeight: number;
  theme: Theme | null;
}> {
  const info = await queryTerminal({ sixel: false });
  return { cellWidth: info.cellWidth, cellHeight: info.cellHeight, theme: info.theme };
}
