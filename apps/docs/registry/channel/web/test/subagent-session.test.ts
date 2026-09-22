import assert from "node:assert/strict";
import { test } from "node:test";
import type { MessageStreamEvent } from "eve/client";
import { chatMessageReducer } from "../lib/chat-message-reducer.ts";
import {
  readSubagentEvents,
  subagentStreamPath,
  type SubagentSession,
} from "../lib/subagent-session.ts";

const child: SubagentSession = {
  sessionId: "parent",
  childSessionId: "child",
  callId: "call",
  childStreamPath: "/eve/v1/session/child/stream",
  name: "worker",
  toolName: "worker",
  turnId: "turn",
  sequence: 1,
  workflowId: "workflow",
};
const called: MessageStreamEvent = {
  type: "subagent.called",
  data: child,
  meta: { id: "called", at: "2026-09-20T12:00:00Z" },
};

test("child references survive replay and unrelated text deltas retain the same reference map", () => {
  const reducer = chatMessageReducer();
  const state = reducer.reduce(reducer.initial(), called);
  assert.equal(state.subagents.call.childSessionId, "child");
  const next = reducer.reduce(state, {
    type: "message.appended",
    data: { messageDelta: "hello", sequence: 1, stepIndex: 0, turnId: "turn" },
    meta: { id: "text", at: called.meta.at },
  });
  assert.equal(next.subagents, state.subagents);
  assert.equal(reducer.reduce(next, called).subagents.call.childSessionId, "child");
});
test("stream URLs bind local child reads to the parent and proxy remote sessions on the same origin", () => {
  assert.equal(
    subagentStreamPath(child, 7),
    "/eve/v1/session/child/stream?startIndex=7&includeTailIndex=1&streamControlVersion=1&parentSessionId=parent&callId=call",
  );
  assert.equal(
    subagentStreamPath({
      ...child,
      childStreamPath: "https://evil.example",
      remote: { url: "https://remote.example" },
    }),
    "/eve/v1/session/parent/subagents/call/child/stream?startIndex=0&includeTailIndex=1&streamControlVersion=1",
  );
});
test("stream reader handles split UTF-8, multiple lines, control records, and final unterminated records", async () => {
  const message = {
    type: "message.completed",
    data: { message: "hello 👋", turnId: "turn", sequence: 1, stepIndex: 0 },
    meta: { id: "text", at: called.meta.at },
  };
  const bytes = new TextEncoder().encode(
    `${JSON.stringify(called)}\n${JSON.stringify({ $eve: "stream.lease-ended", version: 1 })}\n${JSON.stringify(message)}`,
  );
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const events = [];
  for await (const event of readSubagentEvents(streamResponse(body), new AbortController().signal))
    events.push(event);
  assert.deepEqual(events, [called, message]);
});
test("disposing a subscription cancels an idle stream", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = streamResponse(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const reader = readSubagentEvents(response, controller.signal);
  const next = reader.next();
  controller.abort();
  await assert.rejects(next, /abort/i);
  assert.equal(cancelled, true);
});
test("stream HTTP and malformed record failures produce a recoverable error", async () => {
  for (const response of [streamResponse("", { status: 404 }), streamResponse("not json\n")]) {
    await assert.rejects(async () => {
      for await (const _event of readSubagentEvents(response, new AbortController().signal)) {
        /* Consume. */
      }
    });
  }
});

function streamResponse(body?: BodyInit | null, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set("x-eve-stream-version", "25");
  return new Response(body, { ...init, headers });
}

test("the reader rejects missing and unsupported versions before consuming bytes", async () => {
  for (const version of [undefined, "20", "999"]) {
    const response = new Response("{}\n", {
      headers: version ? { "x-eve-stream-version": version } : {},
    });
    await assert.rejects(async () => {
      for await (const _ of readSubagentEvents(response, new AbortController().signal)) {
      }
    }, /version|header/);
  }
});
test("incomplete oversized records cancel the upstream reader", async () => {
  let cancelled = false;
  const response = streamResponse(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024 * 1024 + 1)));
      },
      cancel() {
        cancelled = true;
      },
    }),
  );
  await assert.rejects(async () => {
    for await (const _ of readSubagentEvents(response, new AbortController().signal)) {
    }
  }, /size limit/);
  assert.equal(cancelled, true);
});

test("the pane reader normalizes every supported legacy append version", async () => {
  const data = { messageDelta: "lo", sequence: 3, stepIndex: 0, turnId: "turn" };
  const meta = { id: "legacy", at: "2026-09-21T00:00:00Z" };
  for (const version of ["21", "22", "23", "24"]) {
    const response = new Response(
      JSON.stringify({ type: "message.appended", data: { ...data, messageSoFar: "Hello" }, meta }) +
        "\n",
      { headers: { "x-eve-stream-version": version } },
    );
    const events = [];
    for await (const event of readSubagentEvents(response, new AbortController().signal))
      events.push(event);
    assert.deepEqual(events, [{ type: "message.appended", data, meta }]);
  }
});
