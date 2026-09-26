import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type MessageStreamEvent } from "#client/index.js";
import { conversationReducer } from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import { SubagentPump } from "#client/subagent-pump.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  type SubagentCalledStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function called(
  callId: string,
  sessionId = `child_${callId}`,
  turnId = "parent-turn",
): SubagentCalledStreamEvent {
  return {
    type: "subagent.called",
    data: {
      callId,
      childSessionId: sessionId,
      childStreamPath: `/eve/v1/children/${callId}/stream`,
      name: "researcher",
      sequence: 0,
      sessionId: "parent",
      turnId,
      toolName: "agent",
      workflowId: "workflow",
    },
  };
}
function event(value: UnstampedMessageStreamEvent, index: number): MessageStreamEvent {
  return stampTestEvent(value, index);
}
function waiting(index: number): MessageStreamEvent {
  return event(
    { type: "session.waiting", data: { continuationToken: "child", wait: "next-user-message" } },
    index,
  );
}
function response(events: readonly MessageStreamEvent[]): Response {
  return new Response(events.map((entry) => JSON.stringify(entry)).join("\n") + "\n", {
    headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
  });
}
function serve(
  respond: (startIndex: number, path: string, signal?: AbortSignal) => Response | Promise<Response>,
) {
  const requests: { path: string; cursor: number; signal?: AbortSignal }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const cursor = Number(url.searchParams.get("startIndex") ?? "0");
    const signal = init?.signal ?? undefined;
    requests.push({ path: url.pathname, cursor, signal });
    return await respond(cursor, url.pathname, signal);
  });
  return requests;
}
function setup() {
  let state: ConversationState = conversationReducer.initial();
  const observed: { callId: string; event: MessageStreamEvent }[] = [];
  const pump = new SubagentPump({
    session: (parentSessionId) =>
      new Client({ host: "http://localhost:3000" }).sessions.attach(parentSessionId),
    getCall: (callId) => state.children[callId],
    onFollowing: (callId) => {
      state = conversationReducer.reduce(state, {
        type: "client.child.following",
        data: { callId },
      });
    },
    onChildEvent: (callId, event) => {
      observed.push({ callId, event });
      state = conversationReducer.reduce(state, {
        type: "client.child.observed",
        data: { callId, event },
      });
    },
    onSettled: (data) => {
      state = conversationReducer.reduce(state, {
        type: "client.child.settled",
        data,
      });
    },
  });
  return {
    pump,
    observed,
    get state() {
      return state;
    },
    parent(c: SubagentCalledStreamEvent) {
      state = conversationReducer.reduce(state, event(c, 0));
      pump.acceptParentEvent(event(c, 0));
    },
    project(entry: MessageStreamEvent) {
      state = conversationReducer.reduce(state, entry);
      pump.acceptParentEvent(entry);
    },
    cancel(turnId: string) {
      const cancelled = event({ type: "turn.cancelled", data: { sequence: 0, turnId } }, 0);
      state = conversationReducer.reduce(state, cancelled);
      pump.acceptParentEvent(cancelled);
      pump.reconcile();
    },
  };
}

describe("child event acquisition", () => {
  it("passes child events to canonical state and stops at a call boundary", async () => {
    const requests = serve(() =>
      response([
        event(
          {
            type: "message.completed",
            data: {
              finishReason: "stop",
              message: "Result",
              sequence: 0,
              stepIndex: 0,
              turnId: "child-turn",
            },
          },
          0,
        ),
        waiting(1),
      ]),
    );
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(owner.state.children.a?.observation.status).toBe("ended"));
    expect(owner.state.children.a?.observation).toMatchObject({
      outcome: "completed",
      conversation: {
        messages: [
          expect.objectContaining({
            parts: expect.arrayContaining([expect.objectContaining({ text: "Result" })]),
          }),
        ],
      },
    });
    expect(requests).toHaveLength(1);
  });

  it("retains failed child outcomes instead of treating the next wait as success", async () => {
    serve(() =>
      response([
        event({ type: "turn.started", data: { sequence: 0, turnId: "child-turn" } }, 0),
        event(
          {
            type: "turn.failed",
            data: { sequence: 1, turnId: "child-turn", code: "FAILED", message: "oops" },
          },
          1,
        ),
        waiting(2),
      ]),
    );
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(owner.state.children.a?.observation.status).toBe("ended"));
    expect(owner.state.children.a?.observation).toMatchObject({ outcome: "failed" });
  });

  it("queues a second call on the same child session and resumes at the first call's cursor", async () => {
    const events = [
      event(
        {
          type: "message.completed",
          data: {
            finishReason: "stop",
            message: "First",
            sequence: 0,
            stepIndex: 0,
            turnId: "first-turn",
          },
        },
        0,
      ),
      waiting(1),
      event(
        {
          type: "message.completed",
          data: {
            finishReason: "stop",
            message: "Second",
            sequence: 0,
            stepIndex: 0,
            turnId: "second-turn",
          },
        },
        2,
      ),
      waiting(3),
    ];
    const requests = serve((cursor) => response(events.slice(cursor)));
    const owner = setup();
    owner.parent(called("a", "shared"));
    owner.parent(called("b", "shared"));
    await vi.waitFor(() => expect(owner.state.children.b?.observation.status).toBe("ended"));
    expect(requests.map((request) => request.cursor)).toEqual([0, 2]);
    expect(owner.state.children.a?.observation).toMatchObject({
      conversation: {
        messages: [
          expect.objectContaining({
            parts: expect.arrayContaining([expect.objectContaining({ text: "First" })]),
          }),
        ],
      },
    });
    expect(owner.state.children.b?.observation).toMatchObject({
      conversation: {
        messages: [
          expect.objectContaining({
            parts: expect.arrayContaining([expect.objectContaining({ text: "Second" })]),
          }),
        ],
      },
    });
  });

  it("does not give a queued call the previous invocation's delayed boundary", async () => {
    let finishFirst: (() => void) | undefined;
    const requests = serve((cursor, _path, signal) => {
      if (cursor > 0)
        return response([
          event(
            {
              type: "message.completed",
              data: {
                finishReason: "stop",
                message: "Second",
                sequence: 0,
                stepIndex: 0,
                turnId: "second-turn",
              },
            },
            1,
          ),
          waiting(2),
        ]);
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            finishFirst = () => {
              controller.enqueue(new TextEncoder().encode(`${JSON.stringify(waiting(0))}\n`));
              controller.close();
            };
            signal?.addEventListener("abort", () => controller.error(signal.reason), {
              once: true,
            });
          },
        }),
        { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
      );
    });
    const owner = setup();
    owner.parent(called("a", "shared"));
    owner.parent(called("b", "shared"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(owner.state.children.b?.observation.status).toBe("not-followed");
    finishFirst?.();
    await vi.waitFor(() => expect(owner.state.children.b?.observation.status).toBe("ended"));
    expect(requests.map((request) => request.cursor)).toEqual([0, 1]);
    expect(owner.state.children.b?.observation).toMatchObject({
      conversation: {
        messages: [
          expect.objectContaining({
            parts: expect.arrayContaining([expect.objectContaining({ text: "Second" })]),
          }),
        ],
      },
    });
  });

  it("keeps following an intermediate approval wait until the matching input resolves", async () => {
    const events = [
      event(
        {
          type: "input.requested",
          data: {
            requests: [
              {
                kind: "tool-approval",
                requestId: "req",
                prompt: "Approve?",
                action: { kind: "tool-call", toolName: "lookup", callId: "tool", input: {} },
              },
            ],
            sequence: 0,
            stepIndex: 0,
            turnId: "child-turn",
          },
        },
        0,
      ),
      waiting(1),
      event(
        {
          type: "input.resolved",
          data: {
            resolutions: [{ kind: "tool-approval", requestId: "req", outcome: "approved" }],
            sequence: 1,
            stepIndex: 0,
            turnId: "child-turn",
          },
        },
        2,
      ),
      waiting(3),
    ];
    serve((cursor) => response(events.slice(cursor)));
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(owner.state.children.a?.observation.status).toBe("ended"));
    expect(owner.observed.map(({ event }) => event.type)).toEqual([
      "input.requested",
      "session.waiting",
      "input.resolved",
      "session.waiting",
    ]);
  });

  it("cancels a foreground child subscription with its originating turn", async () => {
    const requests = serve(
      (_cursor, _path, signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
        ),
    );
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    owner.cancel("parent-turn");
    expect(owner.state.children.a?.observation).toMatchObject({
      status: "ended",
      outcome: "cancelled",
    });
    await vi.waitFor(() => expect(requests[0]?.signal?.aborted).toBe(true));
    owner.pump.abortAll();
  });

  it("keeps a background child subscribed after its originating turn is cancelled", async () => {
    const requests = serve(
      (_cursor, _path, signal) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal?.addEventListener("abort", () => controller.error(signal.reason), {
                once: true,
              });
            },
          }),
          { headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION } },
        ),
    );
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const receipt = event(
      {
        type: "action.result",
        data: {
          sequence: 0,
          stepIndex: 0,
          turnId: "parent-turn",
          status: "completed",
          result: {
            kind: "tool-result",
            callId: "a",
            toolName: "agent",
            output: { status: "working", taskId: "task", agentId: "agent" },
          },
        },
      },
      1,
    );
    owner.project(receipt);
    owner.cancel("parent-turn");
    expect(owner.state.children.a).toMatchObject({
      background: true,
      parentStatus: "working",
      observation: { status: "following" },
    });
    expect(requests[0]?.signal?.aborted).toBe(false);
    owner.pump.abortAll();
  });

  it("reports observation failure without attributing it to the child", async () => {
    serve(() => new Response("forbidden", { status: 403 }));
    const owner = setup();
    owner.parent(called("a"));
    await vi.waitFor(() => expect(owner.state.children.a?.observation.status).toBe("unavailable"));
    expect(owner.state.children.a?.observation).toMatchObject({ reason: "stream-error" });
  });
});
