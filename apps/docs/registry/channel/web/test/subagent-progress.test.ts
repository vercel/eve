import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageStreamEvent } from "eve/client";
import {
  elapsedSeconds,
  initialSubagentProgress,
  reduceSubagentProgress,
  terseUpdate,
} from "../lib/subagent-progress.ts";
const at = (seconds: number) => new Date(Date.UTC(2026, 8, 21, 0, 0, seconds)).toISOString();
const event = (type: string, seconds: number, data = {}): MessageStreamEvent =>
  ({ type, data, meta: { id: `${type}-${seconds}`, at: at(seconds) } }) as MessageStreamEvent;

test("elapsed time uses persisted timestamps and freezes only at turn completion", () => {
  let p = reduceSubagentProgress(initialSubagentProgress(), event("session.started", 0));
  p = reduceSubagentProgress(
    p,
    event("message.completed", 10, {
      message: "Found the dates.",
      finishReason: "stop",
      turnId: "t",
      stepIndex: 0,
      sequence: 1,
    }),
  );
  assert.equal(p.phase, "working");
  assert.equal(elapsedSeconds(p, Date.parse(at(12))), 12);
  p = reduceSubagentProgress(p, event("turn.completed", 15));
  assert.equal(p.phase, "done");
  assert.equal(elapsedSeconds(p, Date.parse(at(55))), 15);
  p = reduceSubagentProgress(p, event("session.waiting", 20));
  assert.equal(p.phase, "done");
  assert.equal(elapsedSeconds(p, Date.parse(at(55))), 15);
  p = reduceSubagentProgress(p, event("turn.started", 60));
  assert.equal(p.phase, "working");
  assert.equal(elapsedSeconds(p, Date.parse(at(62))), 2);
});
test("tool results and partial messages never report a finished subagent", () => {
  let p = reduceSubagentProgress(
    initialSubagentProgress(),
    event("action.input.appended", 0, { toolName: "search" }),
  );
  assert.equal(p.update, "Preparing search");
  p = reduceSubagentProgress(
    p,
    event("actions.requested", 1, {
      actions: [{ callId: "c", kind: "tool-call", toolName: "search", input: {} }],
      presentation: { c: { label: "Checking event dates" } },
    }),
  );
  assert.equal(p.update, "Checking event dates");
  p = reduceSubagentProgress(p, event("action.result", 2));
  assert.equal(p.phase, "working");
  for (const [i, messageDelta] of ["Found ", "three conferences"].entries()) {
    p = reduceSubagentProgress(
      p,
      event("message.appended", 3 + i, { messageDelta, turnId: "t", stepIndex: 0, sequence: 1 }),
    );
  }
  assert.equal(p.update, "Found three conferences");
});
test("failure and cancellation survive subsequent waiting events", () => {
  for (const [type, phase] of [
    ["turn.failed", "failed"],
    ["turn.cancelled", "cancelled"],
  ]) {
    let p = reduceSubagentProgress(initialSubagentProgress(), event("turn.started", 0));
    p = reduceSubagentProgress(p, event(type, 8, { message: "Request failed" }));
    p = reduceSubagentProgress(p, event("session.waiting", 9));
    assert.equal(p.phase, phase);
    assert.equal(elapsedSeconds(p, Date.parse(at(40))), 8);
  }
});
test("updates are plain text, a single line, and bounded", () => {
  assert.equal(terseUpdate("**Checking**\n[dates](https://example.com)"), "Checking dates");
  assert.equal(terseUpdate("word ".repeat(100)).length, 140);
  assert.equal(elapsedSeconds(initialSubagentProgress(), Date.now()), 0);
});
