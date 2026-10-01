import { uiEventsFrom } from "./session.js";
import type { ModelMessage, ToolCall, UiEvent } from "./types.js";

export const SYSTEM_PROMPT = `You are Glimmer, a coding agent. Ask questions by calling render_ui so the terminal can draw a real component. Do not ask the user to type a menu.

When the user wants to cut a release, do this in order:
1. choice card titled "Which branch?" with options release/2.4, main, and hotfix/auth
2. form card for the PR title and notes
3. approval card summarizing the plan

The answer arrives as the next user message: a content block {type:"ui-event", event:{componentId, action, value}}. Trust that object.

Spec types: choice, form, approval, table, chart, diff, html.
choice, form, and approval wait for the user. chart and diff display immediately.`;

export const OPENING_USER =
  "Help me cut a release. Ask which branch, then collect the PR details, then ask me to approve.";

export const RENDER_UI_TOOL = {
  name: "render_ui",
  description:
    "Render an interactive UI card in the terminal. choice, form, and approval wait for a structured ui-event user turn. chart, diff, table, and html can be display-only.",
  parameters: {
    type: "object",
    additionalProperties: true,
    properties: {
      spec: {
        type: "object",
        additionalProperties: true,
        description:
          "Component spec. type is choice | form | approval | table | chart | diff | html.",
      },
    },
    required: ["spec"],
  },
} as const;

export interface Model {
  readonly name: string;
  complete(messages: readonly ModelMessage[]): Promise<{ content: string; toolCalls: ToolCall[] }>;
}

function valueText(event: UiEvent): string {
  if (typeof event.value === "string") return event.value;
  return JSON.stringify(event.value);
}

export class MockModel implements Model {
  readonly name = "mock";
  private calls = 0;

  async complete(messages: readonly ModelMessage[]): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const events = uiEventsFrom(messages);
    if (events.length === 0) {
      return {
        content: "Which branch should I cut the release from?",
        toolCalls: [this.call(choiceSpec())],
      };
    }
    const branch = events[0];
    if (events.length === 1 && branch) {
      return {
        content: `Using ${valueText(branch)}. I need the PR title and notes before I open anything.`,
        toolCalls: [this.call(formSpec())],
      };
    }
    const form = events[1];
    if (events.length === 2 && branch && form) {
      const fields = (form.value ?? {}) as { title?: string; notes?: string };
      return {
        content: "Here is the plan. Approve it and I will stop before pushing.",
        toolCalls: [
          this.call({
            type: "approval",
            title: "Open the release PR?",
            body: `Branch ${valueText(branch)}. ${fields.title ?? "Untitled"}.`,
            detail: fields.notes ?? "",
            approveLabel: "Approve",
            rejectLabel: "Reject",
          }),
        ],
      };
    }
    const alreadyShown = messages.some(
      (message) => message.role === "tool" && message.content.includes('"type":"diff"'),
    );
    if (alreadyShown) return { content: "", toolCalls: [] };
    const last = messages[messages.length - 1];
    if (events.length >= 3 && last?.role === "user" && typeof last.content === "string") {
      return { content: `Noted. ${last.content}`, toolCalls: [] };
    }
    const decision = events[2];
    if (decision?.action === "reject") {
      return { content: "Understood. I will not open the PR.", toolCalls: [] };
    }
    const fields = (form?.value ?? {}) as { title?: string };
    return {
      content: `Approved. I'll branch from ${branch ? valueText(branch) : "the selected branch"} and open “${fields.title ?? "the PR"}”. Nothing has been pushed.`,
      toolCalls: [this.call(diffSpec()), this.call(chartSpec())],
    };
  }

  private call(spec: Record<string, unknown>): ToolCall {
    this.calls += 1;
    return { id: `call_${this.calls}`, name: "render_ui", arguments: { spec } };
  }
}

function choiceSpec(): Record<string, unknown> {
  return {
    type: "choice",
    title: "Which branch?",
    prompt: "I'll cut the release from this branch.",
    options: [
      { id: "release/2.4", label: "release/2.4", description: "Stable train, recommended" },
      { id: "main", label: "main", description: "Current trunk" },
      { id: "hotfix/auth", label: "hotfix/auth", description: "Auth regression only" },
    ],
  };
}

function formSpec(): Record<string, unknown> {
  return {
    type: "form",
    title: "Release notes",
    prompt: "What should I put on the pull request?",
    submitLabel: "Continue",
    fields: [
      { name: "title", label: "PR title", placeholder: "Cut 2.4.0" },
      { name: "notes", label: "Notes", placeholder: "What landed?", multiline: true },
    ],
  };
}

function diffSpec(): Record<string, unknown> {
  return {
    type: "diff",
    title: "release.ts",
    before: "export const channel = \"main\";\nexport const notes = \"\";",
    after: "export const channel = \"release/2.4\";\nexport const notes = \"Cherry-pick the auth fix\";",
    wait: false,
  };
}

function chartSpec(): Record<string, unknown> {
  return {
    type: "chart",
    title: "Risk by area",
    unit: "pts",
    series: [
      { label: "auth", value: 2 },
      { label: "api", value: 3 },
      { label: "billing", value: 5 },
    ],
    wait: false,
  };
}

export function selectModel(forceMock = false): Model {
  if (forceMock) return new MockModel();
  const anthropic = process.env.ANTHROPIC_API_KEY;
  const openai = process.env.GLIMMER_API_KEY || process.env.OPENAI_API_KEY;
  const provider = (process.env.GLIMMER_PROVIDER ?? "").toLowerCase();
  if (provider === "mock") return new MockModel();
  if ((provider === "anthropic" || !openai) && anthropic) return new AnthropicModel(anthropic);
  if (openai) return new OpenAIModel(openai);
  return new MockModel();
}

class OpenAIModel implements Model {
  readonly name: string;
  constructor(
    private readonly key: string,
    private readonly baseUrl = process.env.GLIMMER_BASE_URL ?? "https://api.openai.com/v1",
    name = process.env.GLIMMER_MODEL ?? "gpt-4o-mini",
  ) {
    this.name = name;
  }

  async complete(messages: readonly ModelMessage[]): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.name,
        messages: messages.map(toOpenAI),
        tools: [{ type: "function", function: RENDER_UI_TOOL }],
      }),
    });
    if (!response.ok) {
      throw new Error(`model request failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string | null;
          tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
        };
      }>;
    };
    const message = body.choices?.[0]?.message;
    const toolCalls: ToolCall[] = (message?.tool_calls ?? []).map((call) => ({
      id: call.id,
      name: call.function.name,
      arguments: JSON.parse(call.function.arguments || "{}") as Record<string, unknown>,
    }));
    return { content: message?.content ?? "", toolCalls };
  }
}

function toOpenAI(message: ModelMessage): unknown {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.toolCallId, content: message.content };
  }
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }
        : {}),
    };
  }
  if (message.role === "user" && Array.isArray(message.content)) {
    const event = message.content.find((block) => block.type === "ui-event");
    const text = message.content
      .filter((block) => block.type === "text")
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("\n");
    const payload = event && event.type === "ui-event" ? JSON.stringify(event) : "";
    return { role: "user", content: payload ? `${text}\n${payload}` : text };
  }
  return { role: message.role, content: message.content };
}

class AnthropicModel implements Model {
  readonly name: string;
  constructor(
    private readonly key: string,
    name = process.env.GLIMMER_MODEL ?? "claude-sonnet-4-5",
  ) {
    this.name = name;
  }

  async complete(messages: readonly ModelMessage[]): Promise<{ content: string; toolCalls: ToolCall[] }> {
    const system = messages.find((message) => message.role === "system");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.name,
        max_tokens: 1024,
        system: system && system.role === "system" ? system.content : SYSTEM_PROMPT,
        tools: [
          {
            name: RENDER_UI_TOOL.name,
            description: RENDER_UI_TOOL.description,
            input_schema: RENDER_UI_TOOL.parameters,
          },
        ],
        messages: toAnthropic(messages),
      }),
    });
    if (!response.ok) {
      throw new Error(`model request failed (${response.status}): ${await response.text()}`);
    }
    const body = (await response.json()) as {
      content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    };
    const text = (body.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
    const toolCalls: ToolCall[] = (body.content ?? [])
      .filter((block) => block.type === "tool_use")
      .map((block) => ({
        id: block.id ?? `call_${block.name}`,
        name: block.name ?? "render_ui",
        arguments: block.input ?? {},
      }));
    return { content: text, toolCalls };
  }
}

function toAnthropic(messages: readonly ModelMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "assistant") {
      const content: unknown[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      for (const call of message.toolCalls) {
        content.push({ type: "tool_use", id: call.id, name: call.name, input: call.arguments });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    if (message.role === "tool") {
      out.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: message.toolCallId,
            content: message.content,
          },
        ],
      });
      continue;
    }
    if (Array.isArray(message.content)) {
      const event = message.content.find((block) => block.type === "ui-event");
      const text = event && event.type === "ui-event" ? JSON.stringify(event) : "";
      out.push({ role: "user", content: text });
      continue;
    }
    out.push({ role: "user", content: message.content });
  }
  return out;
}
