import type { ContentBlock, ModelMessage, SessionItem, ToolCall, UiEvent } from "./types.js";

export class Session {
  readonly items: SessionItem[] = [];

  constructor(system: string, openingUser?: string) {
    this.items.push({ role: "system", content: system });
    if (openingUser) this.items.push({ role: "user", content: openingUser });
  }

  addUserText(text: string): void {
    this.items.push({ role: "user", content: text });
  }

  addAssistant(content: string, toolCalls: ToolCall[]): void {
    this.items.push({ role: "assistant", content, toolCalls });
  }

  addTool(call: ToolCall, content: string): void {
    this.items.push({ role: "tool", toolCallId: call.id, name: call.name, content });
  }

  /**
   * Record a UI interaction as its own user turn.
   * The event object stays intact on the item and inside a content block.
   */
  recordUiEvent(event: UiEvent, toolCallId?: string): Extract<SessionItem, { event: UiEvent }> {
    const content: ContentBlock[] = [
      { type: "text", text: "The user acted on a live terminal UI component." },
      { type: "ui-event", event },
    ];
    const item: Extract<SessionItem, { event: UiEvent }> = {
      role: "user",
      content,
      event,
      toolCallId,
    };
    this.items.push(item);
    return item;
  }
}

export function isUiTurn(item: SessionItem): item is Extract<SessionItem, { event: UiEvent }> {
  return item.role === "user" && "event" in item;
}

/** Project session items to model messages without flattening UI events into prose. */
export function projectForModel(items: readonly SessionItem[]): ModelMessage[] {
  return items.map((item) => {
    if (isUiTurn(item)) {
      return { role: "user", content: item.content };
    }
    return item;
  });
}

export function uiEventsFrom(messages: readonly ModelMessage[]): UiEvent[] {
  const events: UiEvent[] = [];
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.type === "ui-event") events.push(block.event);
    }
  }
  return events;
}
