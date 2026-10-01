import type { Model } from "./model.js";
import { parseSpec, specTitle } from "./spec.js";
import { projectForModel, Session } from "./session.js";
import type { ResolvedSpec, UiEvent } from "./types.js";

export interface View {
  assistant(text: string): void;
  user(text: string): void;
  show(spec: ResolvedSpec): Promise<void>;
  wait(spec: ResolvedSpec): Promise<UiEvent>;
  status(text: string): void;
}

export async function runLoopUntilIdle(session: Session, model: Model, view: View): Promise<void> {
  for (let step = 0; step < 6; step++) {
    view.status(`${model.name} is thinking`);
    const turn = await model.complete(projectForModel(session.items));
    if (!turn.content.trim() && turn.toolCalls.length === 0) {
      view.status("ready");
      return;
    }
    session.addAssistant(turn.content, turn.toolCalls);
    if (turn.content.trim()) view.assistant(turn.content);
    if (turn.toolCalls.length === 0) {
      view.status("ready");
      return;
    }
    for (const call of turn.toolCalls) {
      if (call.name !== "render_ui") {
        session.addTool(call, `Unknown tool ${call.name}`);
        continue;
      }
      let spec: ResolvedSpec;
      try {
        spec = parseSpec(call.arguments.spec);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        session.addTool(call, `Invalid spec: ${message}`);
        continue;
      }
      view.status(`rendering ${spec.type}`);
      await view.show(spec);
      session.addTool(
        call,
        JSON.stringify({
          status: spec.wait ? "awaiting-interaction" : "shown",
          componentId: spec.id,
          type: spec.type,
        }),
      );
      if (spec.wait) {
        view.status(`${specTitle(spec)} is waiting for you`);
        const event = await view.wait(spec);
        session.recordUiEvent(event, call.id);
      }
    }
  }
  view.status("stopped after too many tool rounds");
}
