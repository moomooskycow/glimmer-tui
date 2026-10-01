# Research

Short survey for the Glimmer prototype, checked on 1 Oct 2026. Sizes are GitHub's reported checkout size.

## Candidate bases

| | [pi](https://github.com/earendil-works/pi) | [Hermes](https://github.com/NousResearch/hermes-agent) | [oh-my-pi](https://github.com/can1357/oh-my-pi) |
| --- | --- | --- | --- |
| Also known as | formerly [badlogic/pi-mono](https://github.com/badlogic/pi-mono) (the API now redirects) | Nous Research hermes-agent | omp |
| Language | TypeScript | Python | TypeScript plus a large Rust core (upstream cites ~80k lines of Rust) |
| Checkout size | ~80 MB (80,211 KB) | ~1.1 GB (1,116,354 KB) | ~660 MB (659,756 KB) |
| License | MIT | MIT | MIT |
| Tool API | Extensions call `registerTool` with a TypeBox-style schema. Same surface can replace built-ins. | Tools self-register on a process-wide registry; plugins call `register_tool`. Dispatch returns strings. | Fork of pi's extension API: `registerTool`, slash commands, flags, plus LSP/DAP natives. |
| TUI | [`pi-tui`](https://github.com/earendil-works/pi/blob/main/packages/tui/README.md): components implement `render(width) => string[]`, differential redraw, synchronized output (CSI 2026), main-screen or alt-screen. Built-in `Image` already speaks Kitty / iTerm2 for static bitmaps. | `prompt_toolkit` application. [`cli.py`](https://github.com/NousResearch/hermes-agent/blob/main/cli.py) is on the order of twenty thousand lines. Widgets, keybindings, and layout are Python hooks on `HermesCLI`. | pi's differential TUI, heavily extended (overlays, mouse viewport, streaming tool chrome). |
| Custom message / render type | First-class. [`CustomMessage`](https://pi.dev/docs/latest/message-types) is a session role (`customType`, structured `content`, `display`, `details`). Extensions add `registerMessageRenderer`. The model sees the custom turn projected to a user message. | `inject_message(content: str)` queues a string. No typed render role. A new visual has to be a prompt_toolkit widget. | Same idea as pi (`registerMessageRenderer`, `sendMessage`) but the renderer now shares a process with the Rust core, so a live DOM does not drop in. |

Docs used: [pi extensions](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent/examples/extensions), [pi message types](https://pi.dev/docs/latest/message-types), [Hermes tools](https://hermes-agent.nousresearch.com/docs/developer-guide/tools-runtime), [Hermes TUI hooks](https://hermes-agent.nousresearch.com/docs/developer-guide/extending-the-cli), [omp extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md).

### Pick: extend pi's session model, do not vendor the monorepo

Pi is the only base that is both small and already shaped for this feature. A `render_ui` tool and a `ui-event` custom message are native extension concepts, and the TUI package is a string renderer with a static image widget. Hermes is a large Python application whose TUI is prompt_toolkit text; a raster card would mean forking `cli.py`. omp is pi plus a Rust engine and a much bigger TUI, which is the wrong direction if the new renderer must own hit testing.

This repo does not fork pi-mono. The live page, mouse mapping, and Kitty protocol do not fit inside `render(width) => string[]` without fighting the differential redraw. Instead the harness copies the part we need: a tool-calling loop, a session that can hold a typed user turn, and a renderer sidecar behind a small interface (`open`, `dispatch`, `play`). That sidecar can later be wrapped as a pi extension (`registerTool` + `CustomMessage`) without importing Hermes or omp.

## Rendering HTML in the terminal

Approach: keep one headless Chromium page per active component (Playwright), screenshot it, and paint the PNG with the [Kitty graphics protocol](https://sw.kovidgoyal.net/kitty/graphics-protocol/). [awrit](https://sw.kovidgoyal.net/kitty/graphics-protocol/) is prior art for a Chromium UI inside Kitty; Glimmer keeps the page offscreen and only ships rasters, so the terminal stays a transcript.

### Placement

Two Kitty placement styles matter:

- **Direct placement** (`a=T` at the cursor, with `c`/`r` in cells). Simple, and the image scrolls with those cells in Kitty, Ghostty, and WezTerm. Redraws leave ghosts unless every placement is deleted first (`a=d`). WezTerm's stable builds are the reason this mode exists.
- **Unicode placeholders** (`a=t` transmit only, then `a=p,U=1`, then `U+10EEEE` plus the [row/column diacritics](https://sw.kovidgoyal.net/kitty/graphics-protocol/#unicode-placeholders)). The image is just text, so it reflows, scrolls, and survives tmux passthrough. Retransmitting the same image id updates every cell that references it, which is how a live card refreshes without moving the cursor. Kitty and current Ghostty implement the full protocol, including placeholders ([Ghostty's unicode placement](https://github.com/ghostty-org/ghostty/blob/master/src/terminal/kitty/graphics_unicode.zig)). WezTerm's placeholder support is still an open change ([wezterm#7924](https://github.com/wezterm/wezterm/pull/7924)), so WezTerm uses direct placement.

Glimmer's alt-screen transcript reprints placeholders every frame and retransmits PNG bytes only when the hash changes. On exit it leaves the alt screen and prints the transcript once into the normal buffer, so the finished cards sit in scrollback.

### Sixel and text

Sixel ([DEC sixel](https://vt100.net/docs/vt3xx-gp/chapter14.html)) is a second bitmap path: a 64-color encoder, explicit `--render sixel`. It is not the default. Ghostty does not implement sixel. The text renderer draws the same components with the same `UiEvent` actions, so a terminal with no graphics protocol still completes the demo.

### Latency, resize, hit testing

- A warm Chromium screenshot of one card is the dominant cost. The browser stays up for the session; only the page is new. Hover screenshots are debounced (~40ms). Expect roughly one to a few frames of lag, not a round trip to a model.
- Cell size comes from `CSI 16 t` (and `TIOCGWINSZ` where pixels are filled in). The PNG is `columns × cellWidth` by `rows × cellHeight` physical pixels. `deviceScaleFactor` is 2 when the cell size divides evenly and the cells are small, so HiDPI terminals get a 1:1 bitmap and low-DPI cells get a supersampled one.
- Resize refits live pages. Frozen cards keep their last PNG and are rescaled into the new cell grid. Historical direct-mode placements are deleted before each frame so they do not ghost.
- Pointers are SGR (`1006`) plus motion (`1003`). Cell coordinates hit the center of the cell; `--mouse pixel` turns on xterm 1016 and maps physical pixels. Both paths are pure functions in `src/pointer.ts`. Keyboard (tab, arrows, enter, typing) goes to the focused page, or to the text widget in the fallback.

### What this does not borrow

No pi, Hermes, or omp source is vendored. Protocol behavior follows the Kitty spec and the public extension docs linked above.
