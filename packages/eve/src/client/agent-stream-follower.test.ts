import { afterEach, describe, expect, it, vi } from "vitest";
import { Client, type MessageStreamEvent } from "#client/index.js";
import { AgentStreamFollower } from "#client/agent-stream-follower.js";
import {
  conversationReducer,
  reduceConversation,
  type ConversationEvent,
} from "#client/conversation-reducer.js";
import type { ConversationState } from "#client/conversation-state.js";
import { stampTestEvent } from "#internal/testing/events.js";
import {
  createAgentStartedEvent,
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  createTaskSettledEvent,
  createTaskStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  EVE_MESSAGE_STREAM_VERSION,
  EVE_STREAM_VERSION_HEADER,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";

afterEach(() => {
  vi.restoreAllMocks();
});

let stamped = 0;
const stamp = (event: UnstampedMessageStreamEvent) => stampTestEvent(event, stamped++);

/** One reply turn, as a researcher session produces it for a call's message. */
function reply(turnId: string, message: string): MessageStreamEvent[] {
  return [
    createTurnStartedEvent({ sequence: 0, turnId }),
    createMessageReceivedEvent({ message: `Question for ${turnId}`, sequence: 0, turnId }),
    createMessageCompletedEvent({
      finishReason: "stop",
      message,
      sequence: 0,
      stepIndex: 0,
      turnId,
    }),
    createTurnCompletedEvent({ sequence: 0, turnId }),
  ].map(stamp);
}

/** Serves the child's stream from each request's cursor, holding it open until aborted. */
function serveChild(events: MessageStreamEvent[]) {
  const requests: { path: string; cursor: number; signal?: AbortSignal }[] = [];
  const openStreams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  let delivered = 0;
  const encode = (event: MessageStreamEvent) =>
    new TextEncoder().encode(`${JSON.stringify(event)}\n`);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const cursor = Number(url.searchParams.get("startIndex") ?? "0");
    const signal = init?.signal ?? undefined;
    requests.push({ path: url.pathname, cursor, signal });
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events.slice(cursor, delivered)) controller.enqueue(encode(event));
        openStreams.add(controller);
        signal?.addEventListener(
          "abort",
          () => {
            openStreams.delete(controller);
            controller.error(signal.reason);
          },
          { once: true },
        );
      },
    });
    return new Response(body, {
      headers: { [EVE_STREAM_VERSION_HEADER]: EVE_MESSAGE_STREAM_VERSION },
    });
  });
  return {
    requests,
    /** Makes the child's next events durable and pushes them to open subscribers. */
    deliver(count = events.length - delivered) {
      const next = events.slice(delivered, delivered + count);
      delivered += next.length;
      for (const controller of openStreams)
        for (const event of next) controller.enqueue(encode(event));
    },
  };
}

function setup() {
  let state: ConversationState = conversationReducer.initial();
  const apply = (event: ConversationEvent) => {
    state = reduceConversation(state, event);
  };
  const follower = new AgentStreamFollower({
    session: new Client({ host: "http://localhost:3000" }).sessions.attach("root"),
    cursors: new Map(),
    getState: () => state,
    onFollowing: (sessionId) => apply({ type: "client.agent.following", data: { sessionId } }),
    onEvent: (sessionId, event) =>
      apply({ type: "client.agent.observed", data: { sessionId, event } }),
    onIdle: (sessionId) => apply({ type: "client.agent.idle", data: { sessionId } }),
    onUnavailable: (sessionId) => apply({ type: "client.agent.unavailable", data: { sessionId } }),
  });
  return {
    get state() {
      return state;
    },
    /** Admits a root event the way the conversation client does. */
    root(event: UnstampedMessageStreamEvent) {
      const accepted = stamp(event);
      apply(accepted);
      follower.acceptParentEvent(accepted);
      follower.reconcile();
    },
    follower,
  };
}

const call = (callId: string, name = "researcher") =>
  createTaskStartedEvent({ callId, name, taskId: "task_1", turnId: "root-turn" });
const settle = (callId: string) =>
  createTaskSettledEvent({
    callId,
    output: "done",
    status: "completed",
    taskId: "task_1",
    turnId: "root-turn",
  });
const agentStarted = (name = "researcher") =>
  createAgentStartedEvent({
    callId: "call_a",
    name,
    parentSessionId: "root",
    sessionId: "child",
    taskId: "task_1",
    turnId: "root-turn",
  });
const replyText = (state: ConversationState) => {
  const observation = state.agents.child?.observation;
  return observation === undefined || observation.status === "not-followed"
    ? []
    : (observation.conversation?.messages ?? []).flatMap((message) =>
        message.role === "assistant"
          ? message.parts.flatMap((part) => (part.type === "text" ? [part.text] : []))
          : [],
      );
};

describe("agent session following", () => {
  it("follows an agent tool's session until its settled calls' replies arrive", async () => {
    const child = serveChild(reply("t1", "Alice's incidents are in the report."));
    const owner = setup();
    owner.root(call("call_a"));
    owner.root(agentStarted());
    await vi.waitFor(() => expect(child.requests).toHaveLength(1));
    // The root settles the call before the child's reply reaches this subscriber.
    owner.root(settle("call_a"));
    expect(owner.state.agents.child?.observation.status).toBe("following");
    child.deliver();
    await vi.waitFor(() => expect(owner.state.agents.child?.observation.status).toBe("idle"));
    expect(replyText(owner.state)).toEqual(["Alice's incidents are in the report."]);
    expect(child.requests[0]).toMatchObject({ path: "/eve/v1/session/child/stream", cursor: 0 });
    expect(child.requests[0]?.signal?.aborted).toBe(true);
  });

  it("resumes from its cursor when a later call reaches the task", async () => {
    const child = serveChild([
      ...reply("t1", "Alice's incidents are in the report."),
      ...reply("t2", "Bob's summary is attached."),
    ]);
    const owner = setup();
    owner.root(call("call_a"));
    owner.root(agentStarted());
    child.deliver(4);
    owner.root(settle("call_a"));
    await vi.waitFor(() => expect(owner.state.agents.child?.observation.status).toBe("idle"));
    owner.root(call("call_b"));
    await vi.waitFor(() => expect(child.requests).toHaveLength(2));
    owner.root(settle("call_b"));
    child.deliver();
    await vi.waitFor(() => expect(owner.state.agents.child?.observation.status).toBe("idle"));
    expect(child.requests.map((request) => request.cursor)).toEqual([0, 4]);
    expect(replyText(owner.state)).toEqual([
      "Alice's incidents are in the report.",
      "Bob's summary is attached.",
    ]);
  });

  it("leaves sessions other tools open to the caller", () => {
    const child = serveChild([]);
    const owner = setup();
    owner.root(call("call_a", "triage"));
    owner.root(agentStarted("researcher"));
    expect(child.requests).toHaveLength(0);
    expect(owner.state.agents.child?.observation.status).toBe("not-followed");
  });

  it("reports a failed stream without retrying it or attributing it to the agent", async () => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("forbidden", { status: 403 }));
    const owner = setup();
    owner.root(call("call_a"));
    owner.root(agentStarted());
    await vi.waitFor(() =>
      expect(owner.state.agents.child?.observation.status).toBe("unavailable"),
    );
    owner.root(call("call_b"));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(owner.state.tasks.task_1?.calls.call_a?.status).toBe("working");
  });
});
