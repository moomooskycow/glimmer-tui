import type { RenderMode } from "./types.js";

export function detectRenderMode(
  env: NodeJS.ProcessEnv = process.env,
  forced?: string,
  sixelCapable = false,
): RenderMode {
  const force = (forced ?? env.GLIMMER_RENDER ?? "auto").toLowerCase();
  if (
    force === "text" ||
    force === "sixel" ||
    force === "kitty-unicode" ||
    force === "kitty-direct"
  ) {
    return force;
  }
  if (force === "kitty") {
    if (env.WEZTERM_PANE && !env.KITTY_WINDOW_ID && !env.GHOSTTY_RESOURCES_DIR) {
      return "kitty-direct";
    }
    return "kitty-unicode";
  }
  const term = env.TERM ?? "";
  const program = env.TERM_PROGRAM ?? "";
  if (
    env.KITTY_WINDOW_ID ||
    env.GHOSTTY_RESOURCES_DIR ||
    program === "ghostty" ||
    term === "xterm-kitty" ||
    term.includes("ghostty")
  ) {
    return "kitty-unicode";
  }
  if (env.WEZTERM_PANE || program === "WezTerm") return "kitty-direct";
  if (termIndicatesFoot(env)) return "sixel";
  if (sixelCapable) return "sixel";
  return "text";
}

/** True when the environment already names foot, so a DA1 probe is unnecessary. */
export function termIndicatesFoot(env: NodeJS.ProcessEnv = process.env): boolean {
  const term = env.TERM ?? "";
  return term === "foot" || term.startsWith("foot-");
}

/**
 * Primary DA (DA1) is `CSI ? Pp ; Ps ; … c`. Pp is the device class.
 * Attribute 4 in the remaining list means sixel graphics.
 */
export function da1SupportsSixel(buffer: string): boolean {
  for (const match of buffer.matchAll(/\x1b\[\?([0-9;]*)c/g)) {
    const parts = (match[1] ?? "").split(";").filter((part) => part.length > 0);
    if (parts.slice(1).includes("4")) return true;
  }
  return false;
}

/** Auto mode still has no graphics decision, so a short DA1 probe is worth it. */
export function wantsSixelProbe(env: NodeJS.ProcessEnv = process.env, forced?: string): boolean {
  const force = (forced ?? env.GLIMMER_RENDER ?? "auto").toLowerCase();
  if (force !== "auto") return false;
  return detectRenderMode(env, forced, false) === "text";
}

export function inTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.TMUX_PANE);
}
