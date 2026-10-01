import type { ComponentSpec, ResolvedSpec } from "./types.js";

let counter = 0;

export function resetSpecIds(start = 0): void {
  counter = start;
}

export function nextComponentId(): string {
  counter += 1;
  return `ui_${counter.toString(36)}`;
}

function defaultWait(spec: ComponentSpec): boolean {
  if (typeof spec.wait === "boolean") return spec.wait;
  if (spec.type === "table") return Boolean(spec.selectable);
  if (spec.type === "chart" || spec.type === "diff" || spec.type === "html") return false;
  return true;
}

export function parseSpec(input: unknown): ResolvedSpec {
  if (!input || typeof input !== "object") {
    throw new Error("render_ui spec must be an object");
  }
  const spec = input as ComponentSpec;
  switch (spec.type) {
    case "choice": {
      if (!spec.title || !Array.isArray(spec.options) || spec.options.length === 0) {
        throw new Error("choice spec needs a title and at least one option");
      }
      const options = spec.options.map((option, index) => {
        if (!option || typeof option.label !== "string") {
          throw new Error(`choice option ${index} needs a label`);
        }
        return {
          id: String(option.id ?? option.label),
          label: option.label,
          description: option.description ? String(option.description) : undefined,
        };
      });
      return { ...spec, options, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "form": {
      if (!spec.title || !Array.isArray(spec.fields) || spec.fields.length === 0) {
        throw new Error("form spec needs a title and at least one field");
      }
      const fields = spec.fields.map((field, index) => {
        if (!field || typeof field.label !== "string") {
          throw new Error(`form field ${index} needs a label`);
        }
        return {
          name: String(field.name ?? field.label),
          label: field.label,
          placeholder: field.placeholder ? String(field.placeholder) : undefined,
          multiline: Boolean(field.multiline),
        };
      });
      return { ...spec, fields, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "approval": {
      if (!spec.title || typeof spec.body !== "string") {
        throw new Error("approval spec needs a title and body");
      }
      return { ...spec, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "table": {
      if (!spec.title || !Array.isArray(spec.columns) || !Array.isArray(spec.rows)) {
        throw new Error("table spec needs a title, columns, and rows");
      }
      return { ...spec, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "chart": {
      if (!spec.title || !Array.isArray(spec.series) || spec.series.length === 0) {
        throw new Error("chart spec needs a title and series");
      }
      return { ...spec, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "diff": {
      if (!spec.title || typeof spec.before !== "string" || typeof spec.after !== "string") {
        throw new Error("diff spec needs a title, before, and after");
      }
      return { ...spec, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    case "html": {
      if (typeof spec.html !== "string" || spec.html.trim() === "") {
        throw new Error("html spec needs an html string");
      }
      return { ...spec, id: spec.id || nextComponentId(), wait: defaultWait(spec) };
    }
    default:
      throw new Error("unknown component type");
  }
}

export function specTitle(spec: { type: string; title?: string }): string {
  return spec.title || spec.type;
}

export function presetField(name: string): string {
  if (name === "title") return "Cut the 2.4 release";
  if (name === "notes") return "Cherry-pick the auth fix";
  return "noted";
}
