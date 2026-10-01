import { ROW_COLUMN_DIACRITICS } from "./diacritics.js";

const PLACEHOLDER = "\u{10EEEE}";

export function diacritic(index: number): string {
  const code = ROW_COLUMN_DIACRITICS[index];
  if (code === undefined) {
    throw new Error(`row/column ${index} exceeds the kitty diacritic table`);
  }
  return String.fromCodePoint(code);
}

/** Foreground color that stores the low 24 bits of a kitty image id. */
export function foregroundForImage(id: number): string {
  const low = id & 0xffffff;
  if ((id >> 24) === 0 && low <= 255) return `\x1b[38;5;${low}m`;
  const r = (low >> 16) & 255;
  const g = (low >> 8) & 255;
  const b = low & 255;
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** One unicode placeholder cell. `extraByte` is the image id's high byte. */
export function placeholderCell(row: number, col: number, extraByte = 0): string {
  let cell = PLACEHOLDER + diacritic(row) + diacritic(col);
  if (extraByte > 0) cell += diacritic(extraByte);
  return cell;
}

export function placeholderGrid(imageId: number, cols: number, rows: number): string[] {
  const extra = (imageId >> 24) & 0xff;
  const color = foregroundForImage(imageId);
  const lines: string[] = [];
  for (let row = 0; row < rows; row++) {
    let line = color;
    for (let col = 0; col < cols; col++) line += placeholderCell(row, col, extra);
    line += "\x1b[39m";
    lines.push(line);
  }
  return lines;
}

export function wrapTmux(sequence: string, enabled: boolean): string {
  if (!enabled) return sequence;
  return `\x1bPtmux;${sequence.replaceAll("\x1b", "\x1b\x1b")}\x1b\\`;
}

function chunked(png: Buffer, header: string, tmux: boolean): string {
  const payload = png.toString("base64");
  const size = 4096;
  let out = "";
  if (payload.length === 0) {
    return wrapTmux(`\x1b_G${header}m=0;\x1b\\`, tmux);
  }
  for (let offset = 0, index = 0; offset < payload.length; offset += size, index++) {
    const part = payload.slice(offset, offset + size);
    const more = offset + size < payload.length ? 1 : 0;
    const prefix = index === 0 ? header : "";
    out += wrapTmux(`\x1b_G${prefix}m=${more};${part}\x1b\\`, tmux);
  }
  return out;
}

export function encodeKittyPng(
  png: Buffer,
  opts: { id: number; cols: number; rows: number; mode: "unicode" | "direct"; tmux?: boolean },
): string {
  const tmux = Boolean(opts.tmux);
  if (opts.mode === "direct") {
    const header = `a=T,f=100,t=d,i=${opts.id},c=${opts.cols},r=${opts.rows},q=2,`;
    return chunked(png, header, tmux);
  }
  const header = `a=t,f=100,t=d,i=${opts.id},q=2,`;
  const transmit = chunked(png, header, tmux);
  const placement = wrapTmux(
    `\x1b_Ga=p,U=1,i=${opts.id},c=${opts.cols},r=${opts.rows},q=2\x1b\\`,
    tmux,
  );
  return transmit + placement;
}

export function deleteAllImages(tmux = false): string {
  return wrapTmux(`\x1b_Ga=d,d=A,q=2\x1b\\`, tmux);
}
