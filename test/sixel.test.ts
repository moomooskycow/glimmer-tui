import assert from "node:assert/strict";
import test from "node:test";
import { PNG } from "pngjs";
import { renderScreen, type ComponentBlock } from "../src/paint.js";
import { parseSpec } from "../src/spec.js";
import { encodeSixel, quantizationStats, reconstructedPng } from "../src/sixel.js";
import { TextWidget } from "../src/textwidget.js";

function solid(width: number, height: number, r: number, g: number, b: number): Buffer {
  const image = new PNG({ width, height });
  for (let i = 0; i < image.data.length; i += 4) {
    image.data[i] = r;
    image.data[i + 1] = g;
    image.data[i + 2] = b;
    image.data[i + 3] = 255;
  }
  return PNG.sync.write(image);
}

test("sixel output carries the raster size and stays within 256 colors", () => {
  const encoded = encodeSixel(solid(2, 2, 255, 255, 255));
  assert.match(encoded, /^\x1bPq"1;1;2;2/);
  assert.ok(encoded.endsWith("\x1b\\"));
  const colors = new Set([...encoded.matchAll(/#(\d+);2;/g)].map((match) => match[1]));
  assert.ok(colors.size <= 256);
  assert.ok(colors.size >= 1);
});

test("adaptive palette beats 64-color quantization on a gradient and keeps flat color", () => {
  const gradient = new PNG({ width: 96, height: 32 });
  for (let y = 0; y < gradient.height; y++) {
    for (let x = 0; x < gradient.width; x++) {
      const i = (y * gradient.width + x) * 4;
      gradient.data[i] = Math.round((x / (gradient.width - 1)) * 255);
      gradient.data[i + 1] = Math.round((y / (gradient.height - 1)) * 255);
      gradient.data[i + 2] = 128;
      gradient.data[i + 3] = 255;
    }
  }
  const gradientPng = PNG.sync.write(gradient);
  const adaptive = quantizationStats(gradientPng, "adaptive");
  const coarse = quantizationStats(gradientPng, "coarse");
  console.log(
    `sixel gradient adaptive mse=${adaptive.mse.toFixed(2)} psnr=${adaptive.psnr.toFixed(2)} colors=${adaptive.paletteSize} exact=${adaptive.exact} | coarse mse=${coarse.mse.toFixed(2)} psnr=${coarse.psnr.toFixed(2)} colors=${coarse.paletteSize}`,
  );
  assert.equal(adaptive.exact, false);
  assert.ok(adaptive.paletteSize <= 256);
  assert.ok(adaptive.paletteSize > coarse.paletteSize);
  assert.ok(adaptive.mse < coarse.mse * 0.5);

  const flat = solid(24, 24, 20, 140, 160);
  const flatAdaptive = quantizationStats(flat, "adaptive");
  const flatCoarse = quantizationStats(flat, "coarse");
  console.log(
    `sixel flat adaptive mse=${flatAdaptive.mse.toFixed(3)} psnr=${flatAdaptive.psnr.toFixed(2)} | coarse mse=${flatCoarse.mse.toFixed(2)} psnr=${flatCoarse.psnr.toFixed(2)}`,
  );
  assert.equal(flatAdaptive.exact, true);
  assert.ok(flatAdaptive.mse < 5);
  assert.ok(flatCoarse.mse > 100);
  assert.ok(flatAdaptive.mse < flatCoarse.mse);
});

test("text-like edges stay solid while the surrounding gradient is dithered", () => {
  const width = 80;
  const height = 48;
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const stripe = x < 40 && y < 16 && x % 2 === 0;
      const glyph = x >= 24 && x < 56 && y >= 20 && y < 40;
      if (glyph) {
        image.data[i] = 0;
        image.data[i + 1] = 0;
        image.data[i + 2] = 0;
      } else if (stripe) {
        image.data[i] = 250;
        image.data[i + 1] = 250;
        image.data[i + 2] = 250;
      } else if (y < 16) {
        image.data[i] = 12;
        image.data[i + 1] = 12;
        image.data[i + 2] = 12;
      } else {
        image.data[i] = 80 + (x % 40);
        image.data[i + 1] = 100 + y;
        image.data[i + 2] = 40 + ((x * 3 + y) % 50);
      }
      image.data[i + 3] = 255;
    }
  }
  const png = PNG.sync.write(image);
  const stats = quantizationStats(png, "adaptive");
  assert.equal(stats.exact, false);
  assert.ok(stats.paletteSize <= 256);
  const decoded = PNG.sync.read(reconstructedPng(png));
  let glyphError = 0;
  let glyphCount = 0;
  for (let y = 24; y < 36; y++) {
    for (let x = 28; x < 52; x++) {
      const i = (y * width + x) * 4;
      glyphError = Math.max(glyphError, decoded.data[i] ?? 0, decoded.data[i + 1] ?? 0, decoded.data[i + 2] ?? 0);
      glyphCount += 1;
    }
  }
  assert.ok(glyphCount > 0);
  assert.ok(glyphError <= 2, `glyph interior drifted by ${glyphError}`);
  let stripeError = 0;
  for (let y = 4; y < 12; y++) {
    for (let x = 2; x < 36; x++) {
      const i = (y * width + x) * 4;
      const value = decoded.data[i] ?? 0;
      const target = x % 2 === 0 ? 250 : 12;
      stripeError = Math.max(stripeError, Math.abs(value - target));
    }
  }
  assert.ok(stripeError <= 16, `stripe drifted by ${stripeError}`);
});

test("sixel frames erase the screen and crop a scrolled card", () => {
  const png = solid(8, 8, 10, 20, 30);
  const spec = parseSpec({
    type: "chart",
    title: "Risk",
    series: [{ label: "auth", value: 2 }],
  });
  const block: ComponentBlock = {
    kind: "component",
    spec,
    widget: new TextWidget(spec),
    png,
    imageId: 3,
    cols: 4,
    rows: 4,
    frozen: false,
    hash: "card",
  };
  const frame = (rows: number, scroll: number) =>
    renderScreen({
      blocks: [block],
      cols: 40,
      rows,
      scroll,
      stick: false,
      composer: "",
      cursor: 0,
      focus: "composer",
      mode: "sixel",
      theme: "dark",
      status: "ready",
      modelName: "mock",
      tmux: false,
      sent: new Map(),
    });
  const top = frame(12, 0);
  assert.match(top.bytes, /\x1b\[\?80l\x1b\[2J/);
  assert.match(top.bytes, /\x1bPq"1;1;8;8/);
  const scrolled = frame(6, 3);
  assert.match(scrolled.bytes, /\x1b\[2J/);
  assert.match(scrolled.bytes, /\x1bPq"1;1;8;4/);
  assert.equal(scrolled.bytes.includes('\x1bPq"1;1;8;8'), false);
  const placement = scrolled.placements.find((item) => item.id === spec.id);
  assert.ok(placement);
  assert.ok(placement.row < 0);
});
