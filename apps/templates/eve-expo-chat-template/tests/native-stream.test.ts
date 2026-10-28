import { test } from "node:test";
import assert from "node:assert/strict";
import type { SessionEvent, SessionStreamEvent } from "eve/client";
import { nativeReply } from "../packages/start/src/native-stream.ts";

function recorded(events: SessionEvent[]) {
  return new ReadableStream<SessionStreamEvent>({
    start(controller) {
      events.forEach((event, line) =>
        controller.enqueue({
          ...event,
          scope: event.scope || { turnId: "turn-1" },
          meta: { at: new Date().toISOString(), position: { line, index: 0 }, endOfLine: true },
        }),
      );
      controller.close();
    },
  });
}

test("current eve stream projects scoped text and tools without duplicating committed text or exposing reasoning/arguments", async () => {
  const stream = recorded([
    {
      type: "content.delta",
      scope: { turnId: "other" },
      data: { partId: "other", kind: "text", delta: "Not this turn" },
    },
    {
      type: "content.delta",
      data: { partId: "reasoning", kind: "reasoning", delta: "private reasoning" },
    },
    { type: "content.delta", data: { partId: "text", kind: "text", delta: "Hello" } },
    {
      type: "content.completed",
      data: {
        partId: "text",
        kind: "text",
        runId: "run",
        phase: "narration",
        value: "Hello world",
      },
    },
    {
      type: "call.input",
      data: { callId: "call", kind: "tool", name: "navigate", delta: "private arguments" },
    },
    {
      type: "call.requested",
      data: {
        callId: "call",
        owner: { runId: "run" },
        capability: { kind: "tool", name: "navigate" },
        input: { secret: "private arguments" },
      },
    },
    { type: "call.started", data: { callId: "call" } },
    {
      type: "call.settled",
      data: { callId: "call", outcome: "completed", output: "private output" },
    },
    {
      type: "content.completed",
      data: { partId: "reply", kind: "text", runId: "run", phase: "reply", value: "Done" },
    },
    { type: "turn.settled", data: { turnId: "turn-1", outcome: "completed" } },
  ]);
  const chunks = [];
  for await (const chunk of nativeReply(stream, Date.now() + 1000, "turn-1")) chunks.push(chunk);
  assert.equal(chunks.filter((chunk) => typeof chunk === "string").join(""), "Hello world\n\nDone");
  assert.deepEqual(
    chunks.filter((chunk) => typeof chunk !== "string"),
    [
      { type: "tool", id: "call", name: "navigate", status: "preparing" },
      { type: "tool", id: "call", name: "navigate", status: "running" },
      { type: "tool", id: "call", name: "navigate", status: "completed" },
    ],
  );
  assert.equal(stream.locked, false);
});

test("terminal native failure completes its response instead of poisoning the work queue", async () => {
  const chunks = [];
  for await (const text of nativeReply(
    recorded([
      { type: "content.delta", data: { partId: "text", kind: "text", delta: "Partial" } },
      {
        type: "turn.settled",
        data: {
          turnId: "turn-1",
          outcome: "failed",
          error: { message: "provider failed", code: "provider_error" },
        },
      },
    ]),
    Date.now() + 1000,
    "turn-1",
  ))
    chunks.push(text);
  assert.match(chunks.join(""), /Partial.*could not finish/s);
});

test("a stalled observer releases its reader at the deadline without treating interruption as a completed turn", async () => {
  let cancelled = false;
  const stream = new ReadableStream<SessionStreamEvent>({
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(async () => {
    for await (const _ of nativeReply(stream, Date.now() + 15)) {
    }
  }, /observation timed out/);
  assert.equal(cancelled, true);
  assert.equal(stream.locked, false);
});
