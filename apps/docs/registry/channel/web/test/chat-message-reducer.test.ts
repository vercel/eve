import assert from "node:assert/strict";
import { test } from "node:test";
import { EveAgentStore, type MessageStreamEvent } from "eve/client";
import { chatMessageReducer } from "../lib/chat-message-reducer.ts";

function received(id: string, message: string): MessageStreamEvent {
  return {
    type: "message.received",
    meta: { id, at: "2026-09-20T01:48:20.000Z" },
    data: { message, sequence: 1, turnId: "turn_1" },
  };
}
const events: MessageStreamEvent[] = [
  received("hi", "hi"),
  {
    type: "message.appended",
    meta: { id: "partial", at: "2026-09-20T01:48:20.000Z" },
    data: { messageDelta: "Four", sequence: 1, stepIndex: 0, turnId: "turn_1" },
  },
  received("one", "one"),
  received("two", "two"),
  received("three", "three"),
  received("three-again", "three"),
  {
    type: "message.completed",
    meta: { id: "complete", at: "2026-09-20T01:48:23.000Z" },
    data: { message: "Four.", finishReason: "stop", sequence: 1, stepIndex: 0, turnId: "turn_1" },
  },
];

function messages(data: ReturnType<ReturnType<typeof chatMessageReducer>["initial"]>) {
  return data.messages.map((message) => ({
    role: message.role,
    text: message.parts
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join(""),
  }));
}

test("retains distinct messages in one turn, including identical text, and deduplicates replay", () => {
  const reducer = chatMessageReducer();
  let data = reducer.initial();
  for (const event of events) data = reducer.reduce(data, event);
  data = reducer.reduce(data, events[3]);
  assert.deepEqual(messages(data), [
    { role: "user", text: "hi" },
    { role: "user", text: "one" },
    { role: "user", text: "two" },
    { role: "user", text: "three" },
    { role: "user", text: "three" },
    { role: "assistant", text: "Four." },
  ]);
  assert.equal(new Set(data.messages.map((message) => message.id)).size, 6);
  assert.ok(data.messages.every((message) => message.metadata?.turnId === "turn_1"));
});

test("restores every message from stored events when returning to a session", () => {
  const reducer = chatMessageReducer();
  const restored = new EveAgentStore({
    host: "http://localhost:3000",
    initialEvents: events,
    initialSession: { sessionId: "wrun_HISTORY", streamIndex: events.length },
    reducer,
  });
  const live = events.reduce((data, event) => reducer.reduce(data, event), reducer.initial());
  assert.deepEqual(restored.snapshot.data, live);
});

test("legacy events without IDs retain sequence-based identities", () => {
  const reducer = chatMessageReducer();
  const legacy = [1, 2, 3].map((sequence) => ({
    ...received("unused", "repeated"),
    meta: { at: "2026-09-20T01:48:20.000Z" },
    data: { message: "repeated", turnId: "turn_1", sequence },
  })) as MessageStreamEvent[];
  const data = [...legacy, legacy[1]].reduce(reducer.reduce, reducer.initial());
  assert.equal(data.messages.length, 3);
  assert.equal(new Set(data.messages.map((message) => message.id)).size, 3);
});
