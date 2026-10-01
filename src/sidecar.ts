import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { PNG } from "pngjs";
import { renderDocument } from "./html.js";
import { presetField } from "./spec.js";
import type {
  DispatchResult,
  DomEvent,
  DomInput,
  RasterRequest,
  RasterResult,
  Renderer,
  ResolvedSpec,
  Theme,
} from "./types.js";

interface LivePage {
  page: Page;
  spec: ResolvedSpec;
}

export class RendererSidecar implements Renderer {
  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly theme: Theme,
    private readonly pages: Map<string, LivePage>,
  ) {}

  static async launch(theme: Theme, dpr: number): Promise<RendererSidecar> {
    const browser = await chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage", "--force-color-profile=srgb", "--font-render-hinting=medium"],
    });
    const context = await browser.newContext({
      deviceScaleFactor: dpr,
      colorScheme: theme,
      viewport: { width: 720, height: 480 },
    });
    return new RendererSidecar(browser, context, theme, new Map());
  }

  async open(spec: ResolvedSpec, request: RasterRequest): Promise<RasterResult> {
    const page = await this.context.newPage();
    await page.setContent(renderDocument(spec, this.theme), { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    this.pages.set(spec.id, { page, spec });
    return this.fit(page, request);
  }

  async refit(id: string, request: RasterRequest): Promise<RasterResult> {
    const live = this.pages.get(id);
    if (!live) throw new Error(`no live page for ${id}`);
    return this.fit(live.page, request);
  }

  async dispatch(id: string, input: DomInput): Promise<DispatchResult> {
    const live = this.pages.get(id);
    if (!live) throw new Error(`no live page for ${id}`);
    const page = live.page;
    if (input.type === "move") await page.mouse.move(input.cssX, input.cssY);
    else if (input.type === "down") await page.mouse.move(input.cssX, input.cssY).then(() => page.mouse.down());
    else if (input.type === "up") await page.mouse.move(input.cssX, input.cssY).then(() => page.mouse.up());
    else if (input.type === "click") await page.mouse.click(input.cssX, input.cssY);
    else if (input.type === "wheel") await page.mouse.wheel(0, input.deltaY);
    else if (input.type === "key") await page.keyboard.press(input.key);
    else if (input.type === "type") await page.keyboard.type(input.text);
    const events = await this.drain(page);
    const png = await this.shoot(page);
    return { png, events };
  }

  async play(spec: ResolvedSpec): Promise<DispatchResult> {
    const live = this.pages.get(spec.id);
    if (!live) throw new Error(`no live page for ${spec.id}`);
    const page = live.page;
    if (spec.type === "choice") {
      await page.locator(`[data-action="select"]`).first().click();
    } else if (spec.type === "form") {
      for (const field of spec.fields) {
        await page.fill(`[name="${cssEscape(field.name)}"]`, presetField(field.name));
      }
      await page.click(`[data-action="submit"]`);
    } else if (spec.type === "approval") {
      await page.click(`[data-action="approve"]`);
    } else if (spec.type === "table" && spec.selectable) {
      await page.click(`[data-action="select-row"]`);
    }
    const events = await this.drain(page);
    const png = await this.shoot(page);
    return { png, events };
  }

  async close(id: string): Promise<void> {
    const live = this.pages.get(id);
    if (!live) return;
    await live.page.close();
    this.pages.delete(id);
  }

  async shutdown(): Promise<void> {
    await this.context.close();
    await this.browser.close();
  }

  async box(id: string, selector: string): Promise<{ x: number; y: number; width: number; height: number } | null> {
    const live = this.pages.get(id);
    if (!live) return null;
    return live.page.locator(selector).boundingBox();
  }

  private async drain(page: Page): Promise<DomEvent[]> {
    return page.evaluate(() => {
      const bag = (window as unknown as { __glimmer?: { events: DomEvent[]; dirty: boolean } }).__glimmer;
      if (!bag) return [];
      const events = bag.events.splice(0);
      bag.dirty = false;
      return events;
    });
  }

  private async shoot(page: Page): Promise<Buffer> {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          requestAnimationFrame(() => resolve());
        }),
    );
    return page.screenshot({ type: "png" });
  }

  private async fit(page: Page, request: RasterRequest): Promise<RasterResult> {
    const dpr = request.dpr || 1;
    const cssWidth = Math.max(1, Math.round((request.cols * request.cellWidth) / dpr));
    await page.setViewportSize({ width: cssWidth, height: 320 });
    const scrollHeight = await page.evaluate(() => {
      const card = document.querySelector(".card");
      if (!(card instanceof HTMLElement)) return Math.ceil(document.documentElement.scrollHeight);
      return Math.ceil(card.getBoundingClientRect().height);
    });
    const maxCss = Math.max(1, Math.round((request.maxRows * request.cellHeight) / dpr));
    let rows = Math.max(1, Math.ceil((Math.min(scrollHeight, maxCss) * dpr) / request.cellHeight));
    rows = Math.min(rows, request.maxRows);
    const pngHeight = rows * request.cellHeight;
    const cssHeight = Math.max(1, Math.round(pngHeight / dpr));
    await page.setViewportSize({ width: cssWidth, height: cssHeight });
    await page.evaluate(() => {
      const card = document.querySelector(".card");
      if (card instanceof HTMLElement) card.style.minHeight = "100%";
    });
    const png = await this.shoot(page);
    const decoded = PNG.sync.read(png);
    return {
      png,
      cols: request.cols,
      rows,
      cssWidth,
      cssHeight: decoded.height / dpr,
    };
  }
}

function cssEscape(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
