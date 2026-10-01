import { runLoopUntilIdle, type View } from "./loop.js";
import { MockModel, OPENING_USER, SYSTEM_PROMPT, type Model } from "./model.js";
import { Session } from "./session.js";
import { scriptedEvent, TextWidget } from "./textwidget.js";
import type { ResolvedSpec, Theme, UiEvent } from "./types.js";

export async function runHeadless(opts: {
  script?: boolean;
  model?: Model;
  theme?: Theme;
  width?: number;
} = {}): Promise<{ session: Session; transcript: string }> {
  const theme = opts.theme ?? "dark";
  const width = opts.width ?? 72;
  const session = new Session(SYSTEM_PROMPT, OPENING_USER);
  const lines: string[] = [`you`, OPENING_USER, ""];
  const widgets = new Map<string, TextWidget>();
  const script = opts.script !== false;
  const view: View = {
    assistant(text) {
      lines.push("agent", text, "");
    },
    user(text) {
      lines.push("you", text, "");
    },
    async show(spec) {
      const widget = new TextWidget(spec);
      widgets.set(spec.id, widget);
      lines.push(...widget.render(width, theme).lines, "");
    },
    async wait(spec) {
      const widget = widgets.get(spec.id);
      if (!widget) throw new Error(`missing component ${spec.id}`);
      const event = script ? scriptedEvent(widget) : await unresolved(spec);
      widget.freezeWith(event);
      lines.push(widget.summary, "");
      return event;
    },
    status() {},
  };
  await runLoopUntilIdle(session, opts.model ?? new MockModel(), view);
  return { session, transcript: lines.join("\n") };
}

function unresolved(spec: ResolvedSpec): Promise<UiEvent> {
  return Promise.reject(new Error(`headless session cannot wait on ${spec.id} without --script`));
}
