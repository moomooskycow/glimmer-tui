import { PNG } from "pngjs";

/**
 * Encode an opaque PNG as a DEC sixel image.
 * The palette is 64 colors (4 levels per channel), which is enough for flat UI chrome.
 */
export function encodeSixel(png: Buffer): string {
  const image = PNG.sync.read(png);
  const { width, height, data } = image;
  const levels = 4;
  const quant = (value: number) => Math.min(levels - 1, Math.round((value / 255) * (levels - 1)));
  const pixels = new Uint8Array(width * height);
  const palette: Array<{ r: number; g: number; b: number } | undefined> = [];
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const r = quant(data[i] ?? 0);
    const g = quant(data[i + 1] ?? 0);
    const b = quant(data[i + 2] ?? 0);
    const index = (r << 4) | (g << 2) | b;
    pixels[p] = index;
    if (!palette[index]) palette[index] = { r, g, b };
  }

  const parts: string[] = [`\x1bPq"1;1;${width};${height}`];
  for (let index = 0; index < palette.length; index++) {
    const color = palette[index];
    if (!color) continue;
    const scale = (level: number) => Math.round((level / (levels - 1)) * 100);
    parts.push(`#${index};2;${scale(color.r)};${scale(color.g)};${scale(color.b)}`);
  }

  for (let y = 0; y < height; y += 6) {
    const used: number[] = [];
    const seen = new Set<number>();
    for (let dy = 0; dy < 6 && y + dy < height; dy++) {
      for (let x = 0; x < width; x++) {
        const index = pixels[x + (y + dy) * width] ?? 0;
        if (!seen.has(index)) {
          seen.add(index);
          used.push(index);
        }
      }
    }
    for (const index of used) {
      let runChar = "";
      let runLen = 0;
      let row = `#${index}`;
      const flush = () => {
        if (runLen === 0) return;
        row += runLen > 2 ? `!${runLen}${runChar}` : runChar.repeat(runLen);
        runLen = 0;
      };
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let dy = 0; dy < 6; dy++) {
          if (y + dy >= height) break;
          if (pixels[x + (y + dy) * width] === index) bits |= 1 << dy;
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
      parts.push(row + "$");
    }
    parts.push("-");
  }
  parts.push("\x1b\\");
  return parts.join("");
}
