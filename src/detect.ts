import type { RenderMode } from "./types.js";

export function detectRenderMode(
  env: NodeJS.ProcessEnv = process.env,
  forced?: string,
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
  return "text";
}

export function inTmux(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.TMUX || env.TMUX_PANE);
}
