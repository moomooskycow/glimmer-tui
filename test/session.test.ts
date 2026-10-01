import assert from "node:assert/strict";
import test from "node:test";
import { MockModel, OPENING_USER, SYSTEM_PROMPT } from "../src/model.js";
import { isUiTurn, projectForModel, Session, uiEventsFrom } from "../src/session.js";
import { runHeadless } from "../src/headless.js";

test("a UI interaction is a typed user turn, not a flattened string", () => {
  const session = new Session("system");
  const event = { componentId: "ui_1", action: "select", value: "release/2.4" };
  const turn = session.recordUiEvent(event, "call_1");
  assert.equal(turn.role, "user");
  assert.equal(typeof turn.content, "object");
  assert.deepEqual(turn.event, event);
  assert.equal(isUiTurn(turn), true);

  const projected = projectForModel(session.items);
  const user = projected.find((message) => message.role === "user");
  assert.ok(user && Array.isArray(user.content));
  const block = user.content.find((item) => item.type === "ui-event");
  assert.ok(block && block.type === "ui-event");
  assert.deepEqual(block.event, event);
  assert.deepEqual(uiEventsFrom(projected), [event]);
  assert.equal(JSON.stringify(turn).includes('"action":"select"'), true);
});

test("the scripted release demo threads each choice back into the session", async () => {
  const { session } = await runHeadless({ script: true, model: new MockModel() });
  assert.equal(session.items[0]?.role, "system");
  assert.equal(session.items[0]?.content, SYSTEM_PROMPT);
  assert.equal(session.items[1]?.role, "user");
  assert.equal(session.items[1] && "content" in session.items[1] ? session.items[1].content : "", OPENING_USER);

  const events = session.items.filter(isUiTurn).map((item) => item.event);
  assert.deepEqual(
    events.map((event) => event.action),
    ["select", "submit", "approve"],
  );
  assert.equal(events[0]?.value, "release/2.4");
  assert.deepEqual(events[1]?.value, {
    title: "Cut the 2.4 release",
    notes: "Cherry-pick the auth fix",
  });
  assert.equal(events[2]?.value, true);

  const projected = projectForModel(session.items);
  assert.equal(uiEventsFrom(projected).length, 3);
  const assistants = session.items.filter((item) => item.role === "assistant");
  const final = assistants[assistants.length - 1];
  assert.ok(final && final.role === "assistant");
  assert.match(final.content, /release\/2\.4/);
  assert.match(final.content, /Cut the 2\.4 release/);
  assert.equal(final.toolCalls.some((call) => call.name === "render_ui"), true);
});
