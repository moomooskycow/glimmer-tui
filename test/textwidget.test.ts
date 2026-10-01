import assert from "node:assert/strict";
import test from "node:test";
import { parseSpec } from "../src/spec.js";
import { scriptedEvent, TextWidget } from "../src/textwidget.js";

test("arrow keys and enter select a choice", () => {
  const widget = new TextWidget(
    parseSpec({
      type: "choice",
      id: "ui_choice",
      title: "Which branch?",
      options: [
        { id: "release/2.4", label: "release/2.4" },
        { id: "main", label: "main" },
      ],
    }),
  );
  assert.equal(widget.handleKey({ type: "down" }), null);
  const event = widget.handleKey({ type: "enter" });
  assert.deepEqual(event, { componentId: "ui_choice", action: "select", value: "main" });
});

test("tab, typing, and enter submit a form", () => {
  const widget = new TextWidget(
    parseSpec({
      type: "form",
      id: "ui_form",
      title: "Notes",
      fields: [
        { name: "title", label: "Title" },
        { name: "notes", label: "Notes" },
      ],
    }),
  );
  widget.handleKey({ type: "char", text: "Cut" });
  widget.handleKey({ type: "tab" });
  widget.handleKey({ type: "char", text: "Auth" });
  const event = widget.handleKey({ type: "enter" });
  assert.deepEqual(event, {
    componentId: "ui_form",
    action: "submit",
    value: { title: "Cut", notes: "Auth" },
  });
});

test("approval defaults to approve and y/n still work after navigation", () => {
  const widget = new TextWidget(
    parseSpec({
      type: "approval",
      id: "ui_ok",
      title: "Ship?",
      body: "Now",
    }),
  );
  assert.equal(widget.handleKey({ type: "enter" })?.action, "approve");
  const again = new TextWidget(
    parseSpec({ type: "approval", id: "ui_no", title: "Ship?", body: "Now" }),
  );
  again.handleKey({ type: "right" });
  assert.equal(again.handleKey({ type: "enter" })?.value, false);
});

test("the scripted path uses the same keyboard handlers", () => {
  const widget = new TextWidget(
    parseSpec({
      type: "choice",
      title: "Which branch?",
      options: [{ id: "release/2.4", label: "release/2.4", description: "Stable" }],
    }),
  );
  const rendered = widget.render(40, "dark");
  assert.equal(rendered.lines.some((line) => line.includes("release/2.4")), true);
  assert.equal(scriptedEvent(widget).value, "release/2.4");
  widget.freezeWith({ componentId: widget.spec.id, action: "select", value: "release/2.4" });
  assert.equal(widget.handleKey({ type: "enter" }), null);
});
