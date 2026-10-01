import { createHash } from "node:crypto";
import { PNG } from "pngjs";

/**
 * Encode an opaque PNG as a DEC sixel image.
 *
 * Colors are snapped onto the sixel grid (101 levels per channel) first.
 * When that set still fits in 256 registers, every color is kept and nothing
 * is dithered, which leaves UI text on its antialiased steps. Past 256, a
 * median-cut palette is dithered with Floyd–Steinberg except on flat fills
 * and high-contrast edges, so glyph cores do not speckle.
 */
export interface SixelView {
  /** First visible cell row of the image. */
  firstRow: number;
  /** How many cell rows to emit. */
  rows: number;
  /** Cell rows in the full bitmap. */
  totalRows: number;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

interface Indexed {
  width: number;
  height: number;
  pixels: Uint8Array;
  palette: RGB[];
  exact: boolean;
}

export interface QuantStats {
  paletteSize: number;
  mse: number;
  psnr: number;
  exact: boolean;
}

const MAX_COLORS = 256;
const FLAT_ERROR = 12;
const EDGE_CONTRAST = 36;
const indexedCache = new Map<string, Indexed>();
const encodedCache = new Map<string, string>();

export function encodeSixel(png: Buffer, view?: SixelView): string {
  const indexed = quantize(png);
  const slice = sliceRows(indexed.height, view);
  const key = `${hashPng(png)}:${slice.y}:${slice.height}`;
  const cached = encodedCache.get(key);
  if (cached) return cached;
  const encoded = writeSixel(indexed, slice.y, slice.height);
  remember(encodedCache, key, encoded, 32);
  return encoded;
}

export function reconstructedPng(png: Buffer): Buffer {
  const indexed = quantize(png);
  const out = new PNG({ width: indexed.width, height: indexed.height });
  for (let p = 0; p < indexed.pixels.length; p++) {
    const color = indexed.palette[indexed.pixels[p] ?? 0] ?? { r: 0, g: 0, b: 0 };
    const i = p * 4;
    out.data[i] = color.r;
    out.data[i + 1] = color.g;
    out.data[i + 2] = color.b;
    out.data[i + 3] = 255;
  }
  return PNG.sync.write(out);
}

export function quantizationStats(png: Buffer, method: "adaptive" | "coarse" = "adaptive"): QuantStats {
  const image = PNG.sync.read(png);
  if (method === "coarse") return coarseStats(image);
  const indexed = quantize(png);
  return statsFrom(image.data, image.width, image.height, indexed.pixels, indexed.palette, indexed.exact);
}

export function resamplePng(png: Buffer, width: number, height: number): Buffer {
  const src = PNG.sync.read(png);
  if (src.width === width && src.height === height) return png;
  const dst = new PNG({ width, height });
  const xScale = src.width / width;
  const yScale = src.height / height;
  for (let y = 0; y < height; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * yScale - 0.5));
    const y0 = Math.floor(sy);
    const y1 = Math.min(src.height - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < width; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * xScale - 0.5));
      const x0 = Math.floor(sx);
      const x1 = Math.min(src.width - 1, x0 + 1);
      const fx = sx - x0;
      const i = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) {
        const c00 = src.data[(y0 * src.width + x0) * 4 + channel] ?? 0;
        const c10 = src.data[(y0 * src.width + x1) * 4 + channel] ?? 0;
        const c01 = src.data[(y1 * src.width + x0) * 4 + channel] ?? 0;
        const c11 = src.data[(y1 * src.width + x1) * 4 + channel] ?? 0;
        const top = c00 + (c10 - c00) * fx;
        const bottom = c01 + (c11 - c01) * fx;
        dst.data[i + channel] = Math.round(top + (bottom - top) * fy);
      }
      dst.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(dst);
}

function quantize(png: Buffer): Indexed {
  const key = hashPng(png);
  const cached = indexedCache.get(key);
  if (cached) return cached;
  const image = PNG.sync.read(png);
  const indexed = indexImage(image.data, image.width, image.height);
  remember(indexedCache, key, indexed, 24);
  return indexed;
}

function indexImage(data: Buffer, width: number, height: number): Indexed {
  const displayable = collectDisplayable(data, width, height);
  if (displayable) return { width, height, ...displayable, exact: true };
  const buckets = histogramSnapped(data, width, height);
  const palette = snapPalette(medianCut(buckets, MAX_COLORS));
  const lut = nearestLut(palette);
  const pixels = dither(data, width, height, palette, lut);
  return { width, height, pixels, palette, exact: false };
}

/**
 * Sixel only stores 101 levels per channel. Count colors after that snap.
 * UI text is a ramp of those levels; keeping every one (up to 256) avoids
 * dither speckle on glyphs. Median-cut runs only when the ramp does not fit.
 */
function collectDisplayable(
  data: Buffer,
  width: number,
  height: number,
): { pixels: Uint8Array; palette: RGB[] } | null {
  const lookup = new Map<number, number>();
  const palette: RGB[] = [];
  const count = width * height;
  for (let p = 0; p < count; p++) {
    const key = pack(snappedPixel(data, p));
    if (lookup.has(key)) continue;
    if (lookup.size >= MAX_COLORS) return null;
    lookup.set(key, palette.length);
    palette.push(unpack(key));
  }
  const pixels = new Uint8Array(count);
  for (let p = 0; p < count; p++) {
    pixels[p] = lookup.get(pack(snappedPixel(data, p))) ?? 0;
  }
  return { pixels, palette: palette.length > 0 ? palette : [{ r: 0, g: 0, b: 0 }] };
}

function snappedPixel(data: Buffer, pixel: number): RGB {
  const i = pixel * 4;
  return {
    r: fromSixel(toSixel(data[i] ?? 0)),
    g: fromSixel(toSixel(data[i + 1] ?? 0)),
    b: fromSixel(toSixel(data[i + 2] ?? 0)),
  };
}

interface Bucket {
  r: number;
  g: number;
  b: number;
  n: number;
}

function histogramSnapped(data: Buffer, width: number, height: number): Bucket[] {
  const counts = new Map<number, number>();
  const pixels = width * height;
  for (let p = 0; p < pixels; p++) {
    const key = pack(snappedPixel(data, p));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const colors: Bucket[] = [];
  for (const [key, n] of counts) {
    const color = unpack(key);
    colors.push({ r: color.r, g: color.g, b: color.b, n });
  }
  return colors;
}

interface Box {
  colors: Bucket[];
  r0: number;
  r1: number;
  g0: number;
  g1: number;
  b0: number;
  b1: number;
  count: number;
}

function medianCut(colors: Bucket[], maxColors: number): RGB[] {
  if (colors.length === 0) return [{ r: 0, g: 0, b: 0 }];
  if (colors.length <= maxColors) return colors.map(modeColor);
  const boxes = [bounds(colors)];
  const unsplittable = new WeakSet<Box>();
  while (boxes.length < maxColors) {
    let best = -1;
    let bestScore = 0;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (!box || box.colors.length < 2 || unsplittable.has(box)) continue;
      const score = (box.r1 - box.r0 + box.g1 - box.g0 + box.b1 - box.b0) * Math.sqrt(box.count);
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    const box = best >= 0 ? boxes[best] : undefined;
    if (!box) break;
    const parts = splitBox(box);
    if (!parts) {
      unsplittable.add(box);
      continue;
    }
    boxes.splice(best, 1, parts[0], parts[1]);
  }
  return boxes.map(modeColor);
}

function bounds(colors: Bucket[]): Box {
  let r0 = 255;
  let r1 = 0;
  let g0 = 255;
  let g1 = 0;
  let b0 = 255;
  let b1 = 0;
  let count = 0;
  for (const color of colors) {
    if (color.r < r0) r0 = color.r;
    if (color.r > r1) r1 = color.r;
    if (color.g < g0) g0 = color.g;
    if (color.g > g1) g1 = color.g;
    if (color.b < b0) b0 = color.b;
    if (color.b > b1) b1 = color.b;
    count += color.n;
  }
  return { colors, r0, r1, g0, g1, b0, b1, count };
}

function splitBox(box: Box): [Box, Box] | null {
  const dr = box.r1 - box.r0;
  const dg = box.g1 - box.g0;
  const db = box.b1 - box.b0;
  const axis: "r" | "g" | "b" = dr >= dg && dr >= db ? "r" : dg >= db ? "g" : "b";
  if ((axis === "r" ? dr : axis === "g" ? dg : db) <= 0) return null;
  const sorted = box.colors.slice().sort((a, b) => a[axis] - b[axis]);
  const half = box.count / 2;
  let acc = 0;
  let index = 0;
  for (; index < sorted.length - 1; index++) {
    acc += sorted[index]?.n ?? 0;
    if (acc >= half) break;
  }
  let left = sorted.slice(0, index + 1);
  let right = sorted.slice(index + 1);
  if (right.length === 0) {
    const dominant = sorted[sorted.length - 1];
    left = sorted.slice(0, -1);
    right = dominant ? [dominant] : [];
  }
  if (left.length === 0 || right.length === 0) return null;
  return [bounds(left), bounds(right)];
}

function modeColor(box: Box | Bucket): RGB {
  const colors = "colors" in box ? box.colors : [box];
  let best = colors[0];
  for (const color of colors) {
    if (!best || color.n > best.n) best = color;
  }
  return {
    r: Math.round(best?.r ?? 0),
    g: Math.round(best?.g ?? 0),
    b: Math.round(best?.b ?? 0),
  };
}

function snapPalette(colors: RGB[]): RGB[] {
  const seen = new Map<number, RGB>();
  const palette: RGB[] = [];
  for (const color of colors) {
    const snapped = {
      r: fromSixel(toSixel(color.r)),
      g: fromSixel(toSixel(color.g)),
      b: fromSixel(toSixel(color.b)),
    };
    const key = pack(snapped);
    if (seen.has(key)) continue;
    seen.set(key, snapped);
    palette.push(snapped);
  }
  return palette.length > 0 ? palette : [{ r: 0, g: 0, b: 0 }];
}

function nearestLut(palette: RGB[]): Uint16Array {
  const lut = new Uint16Array(32 * 32 * 32);
  for (let slot = 0; slot < lut.length; slot++) {
    const r = ((slot >> 10) & 31) * 8 + 4;
    const g = ((slot >> 5) & 31) * 8 + 4;
    const b = (slot & 31) * 8 + 4;
    lut[slot] = nearestIndex(palette, r, g, b);
  }
  return lut;
}

function nearestIndex(palette: RGB[], r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let index = 0; index < palette.length; index++) {
    const color = palette[index];
    if (!color) continue;
    const dr = r - color.r;
    const dg = g - color.g;
    const db = b - color.b;
    const distance = dr * dr + dg * dg + db * db;
    if (distance < bestD) {
      bestD = distance;
      best = index;
    }
  }
  return best;
}

function dither(data: Buffer, width: number, height: number, palette: RGB[], lut: Uint16Array): Uint8Array {
  const work = new Float32Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    work[p * 3] = data[p * 4] ?? 0;
    work[p * 3 + 1] = data[p * 4 + 1] ?? 0;
    work[p * 3 + 2] = data[p * 4 + 2] ?? 0;
  }
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const forward = y % 2 === 0;
    for (let step = 0; step < width; step++) {
      const x = forward ? step : width - 1 - step;
      const at = (y * width + x) * 3;
      const r = clamp(work[at] ?? 0);
      const g = clamp(work[at + 1] ?? 0);
      const b = clamp(work[at + 2] ?? 0);
      const index = lut[((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3)] ?? 0;
      pixels[y * width + x] = index;
      const color = palette[index] ?? { r: 0, g: 0, b: 0 };
      const er = r - color.r;
      const eg = g - color.g;
      const eb = b - color.b;
      if (Math.max(Math.abs(er), Math.abs(eg), Math.abs(eb)) <= FLAT_ERROR) continue;
      if (highContrast(data, width, height, x, y)) continue;
      const dir = forward ? 1 : -1;
      spread(work, width, height, x + dir, y, er, eg, eb, 7 / 16);
      spread(work, width, height, x - dir, y + 1, er, eg, eb, 3 / 16);
      spread(work, width, height, x, y + 1, er, eg, eb, 5 / 16);
      spread(work, width, height, x + dir, y + 1, er, eg, eb, 1 / 16);
    }
  }
  return pixels;
}

function highContrast(data: Buffer, width: number, height: number, x: number, y: number): boolean {
  const i = (y * width + x) * 4;
  const r = data[i] ?? 0;
  const g = data[i + 1] ?? 0;
  const b = data[i + 2] ?? 0;
  const neighbors = [
    [x + 1, y],
    [x - 1, y],
    [x, y + 1],
    [x, y - 1],
  ];
  for (const [nx, ny] of neighbors) {
    if (nx === undefined || ny === undefined) continue;
    if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
    const j = (ny * width + nx) * 4;
    const delta = Math.max(
      Math.abs(r - (data[j] ?? 0)),
      Math.abs(g - (data[j + 1] ?? 0)),
      Math.abs(b - (data[j + 2] ?? 0)),
    );
    if (delta >= EDGE_CONTRAST) return true;
  }
  return false;
}

function spread(
  work: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  er: number,
  eg: number,
  eb: number,
  factor: number,
): void {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const at = (y * width + x) * 3;
  work[at] = (work[at] ?? 0) + er * factor;
  work[at + 1] = (work[at + 1] ?? 0) + eg * factor;
  work[at + 2] = (work[at + 2] ?? 0) + eb * factor;
}

function writeSixel(indexed: Indexed, y0: number, height: number): string {
  const { width, pixels, palette } = indexed;
  const y1 = Math.min(indexed.height, y0 + height);
  const used: number[] = [];
  const seen = new Set<number>();
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < width; x++) {
      const index = pixels[y * width + x] ?? 0;
      if (seen.has(index)) continue;
      seen.add(index);
      used.push(index);
    }
  }
  used.sort((a, b) => a - b);
  const parts: string[] = [`\x1bPq"1;1;${width};${y1 - y0}`];
  for (const index of used) {
    const color = palette[index] ?? { r: 0, g: 0, b: 0 };
    parts.push(`#${index};2;${toSixel(color.r)};${toSixel(color.g)};${toSixel(color.b)}`);
  }
  for (let y = y0; y < y1; y += 6) {
    const band: number[] = [];
    const bandSeen = new Set<number>();
    for (let dy = 0; dy < 6 && y + dy < y1; dy++) {
      for (let x = 0; x < width; x++) {
        const index = pixels[(y + dy) * width + x] ?? 0;
        if (bandSeen.has(index)) continue;
        bandSeen.add(index);
        band.push(index);
      }
    }
    for (const index of band) {
      let runChar = "";
      let runLen = 0;
      let row = `#${index}`;
      const flush = () => {
        if (runLen === 0) return;
        while (runLen > 255) {
          row += `!255${runChar}`;
          runLen -= 255;
        }
        row += runLen > 2 ? `!${runLen}${runChar}` : runChar.repeat(runLen);
        runLen = 0;
      };
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let dy = 0; dy < 6; dy++) {
          if (y + dy >= y1) break;
          if (pixels[(y + dy) * width + x] === index) bits |= 1 << dy;
        }
        const ch = String.fromCharCode(63 + bits);
        if (ch === runChar) runLen += 1;
        else {
          flush();
          runChar = ch;
          runLen = 1;
        }
      }
      flush();
      parts.push(`${row}$`);
    }
    parts.push("-");
  }
  parts.push("\x1b\\");
  return parts.join("");
}

function sliceRows(pngHeight: number, view: SixelView | undefined): { y: number; height: number } {
  if (!view || view.totalRows <= 0 || view.rows <= 0) return { y: 0, height: pngHeight };
  const first = Math.max(0, Math.min(view.totalRows - 1, view.firstRow));
  const rows = Math.max(1, Math.min(view.rows, view.totalRows - first));
  const y = Math.round((first * pngHeight) / view.totalRows);
  const bottom = Math.round(((first + rows) * pngHeight) / view.totalRows);
  return { y, height: Math.max(1, Math.min(pngHeight - y, bottom - y)) };
}

function coarseStats(image: PNG): QuantStats {
  const levels = 4;
  const quant = (value: number) => Math.min(levels - 1, Math.round((value / 255) * (levels - 1)));
  const scale = (level: number) => Math.round((level / (levels - 1)) * 255);
  const palette: RGB[] = [];
  const lookup = new Map<number, number>();
  const pixels = new Uint8Array(image.width * image.height);
  let error = 0;
  for (let p = 0; p < pixels.length; p++) {
    const i = p * 4;
    const r = quant(image.data[i] ?? 0);
    const g = quant(image.data[i + 1] ?? 0);
    const b = quant(image.data[i + 2] ?? 0);
    const key = (r << 4) | (g << 2) | b;
    let index = lookup.get(key);
    if (index === undefined) {
      index = palette.length;
      lookup.set(key, index);
      palette.push({ r: scale(r), g: scale(g), b: scale(b) });
    }
    pixels[p] = index;
    const color = palette[index] ?? { r: 0, g: 0, b: 0 };
    error += (image.data[i]! - color.r) ** 2;
    error += (image.data[i + 1]! - color.g) ** 2;
    error += (image.data[i + 2]! - color.b) ** 2;
  }
  const mse = error / (pixels.length * 3);
  return { paletteSize: palette.length, mse, psnr: psnrOf(mse), exact: false };
}

function statsFrom(data: Buffer, width: number, height: number, pixels: Uint8Array, palette: RGB[], exact: boolean): QuantStats {
  let error = 0;
  const count = width * height;
  for (let p = 0; p < count; p++) {
    const color = palette[pixels[p] ?? 0] ?? { r: 0, g: 0, b: 0 };
    const i = p * 4;
    error += ((data[i] ?? 0) - color.r) ** 2;
    error += ((data[i + 1] ?? 0) - color.g) ** 2;
    error += ((data[i + 2] ?? 0) - color.b) ** 2;
  }
  const mse = error / (count * 3);
  return { paletteSize: palette.length, mse, psnr: psnrOf(mse), exact };
}

function psnrOf(mse: number): number {
  if (mse <= 1e-9) return Number.POSITIVE_INFINITY;
  return 10 * Math.log10((255 * 255) / mse);
}

function toSixel(value: number): number {
  return Math.max(0, Math.min(100, Math.round((value / 255) * 100)));
}

function fromSixel(value: number): number {
  return Math.max(0, Math.min(255, Math.round((value / 100) * 255)));
}

function pack(color: RGB): number {
  return (color.r << 16) | (color.g << 8) | color.b;
}

function unpack(key: number): RGB {
  return { r: (key >> 16) & 255, g: (key >> 8) & 255, b: key & 255 };
}

function clamp(value: number): number {
  if (value < 0) return 0;
  if (value > 255) return 255;
  return Math.round(value);
}

function hashPng(png: Buffer): string {
  return createHash("sha1").update(png).digest("hex");
}

function remember<T>(cache: Map<string, T>, key: string, value: T, limit: number): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}
