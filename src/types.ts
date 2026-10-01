export type Theme = "light" | "dark";

export type RenderMode = "kitty-unicode" | "kitty-direct" | "sixel" | "text";

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
}

export interface FormField {
  name: string;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}

export interface TableColumn {
  key: string;
  label: string;
}

export interface ChartPoint {
  label: string;
  value: number;
}

export type ComponentSpec =
  | {
      type: "choice";
      id?: string;
      title: string;
      prompt?: string;
      options: ChoiceOption[];
      wait?: boolean;
    }
  | {
      type: "form";
      id?: string;
      title: string;
      prompt?: string;
      fields: FormField[];
      submitLabel?: string;
      wait?: boolean;
    }
  | {
      type: "approval";
      id?: string;
      title: string;
      body: string;
      detail?: string;
      approveLabel?: string;
      rejectLabel?: string;
      wait?: boolean;
    }
  | {
      type: "table";
      id?: string;
      title: string;
      columns: TableColumn[];
      rows: Record<string, string>[];
      selectable?: boolean;
      wait?: boolean;
    }
  | {
      type: "chart";
      id?: string;
      title: string;
      unit?: string;
      series: ChartPoint[];
      wait?: boolean;
    }
  | {
      type: "diff";
      id?: string;
      title: string;
      before: string;
      after: string;
      wait?: boolean;
    }
  | {
      type: "html";
      id?: string;
      title?: string;
      html: string;
      wait?: boolean;
    };

export type ResolvedSpec = ComponentSpec & { id: string; wait: boolean };

/** A meaningful UI interaction. Stored on the session as a typed user turn. */
export interface UiEvent {
  componentId: string;
  action: string;
  value: unknown;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "ui-event"; event: UiEvent };

export type SessionItem =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | {
      role: "user";
      content: ContentBlock[];
      event: UiEvent;
      toolCallId?: string;
    }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export type ModelMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | ContentBlock[] }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

export interface Geometry {
  cols: number;
  rows: number;
  cellWidth: number;
  cellHeight: number;
  dpr: number;
}

export interface RasterRequest {
  cols: number;
  cellWidth: number;
  cellHeight: number;
  dpr: number;
  maxRows: number;
}

export interface RasterResult {
  png: Buffer;
  cols: number;
  rows: number;
  cssWidth: number;
  cssHeight: number;
}

export type DomInput =
  | { type: "click" | "move" | "down" | "up"; cssX: number; cssY: number }
  | { type: "wheel"; cssX: number; cssY: number; deltaY: number }
  | { type: "key"; key: string }
  | { type: "type"; text: string };

export interface DomEvent {
  action: string;
  value: unknown;
  complete: boolean;
}

export interface DispatchResult {
  png: Buffer;
  events: DomEvent[];
}

export interface Renderer {
  open(spec: ResolvedSpec, request: RasterRequest): Promise<RasterResult>;
  dispatch(id: string, input: DomInput): Promise<DispatchResult>;
  play(spec: ResolvedSpec): Promise<DispatchResult>;
  refit(id: string, request: RasterRequest): Promise<RasterResult>;
  close(id: string): Promise<void>;
  shutdown(): Promise<void>;
}
