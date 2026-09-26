import { describe, expect, it } from "vitest";
import { EveAgentProjection } from "#client/eve-agent-projection.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { OptimisticMessageSubmissions } from "#client/optimistic-message-submissions.js";
import { stampTestEvents } from "#internal/testing/events.js";
import {
  createMessageCompletedEvent,
  createMessageReceivedEvent,
  type MessageStreamEvent,
} from "#protocol/message.js";

function received(
  message: string,
  deliveryIds: readonly string[],
): Extract<MessageStreamEvent, { readonly type: "message.received" }> {
  const event = createMessageReceivedEvent({
    message,
    sequence: 0,
    turnId: `turn_${deliveryIds[0]}`,
  });
  return {
    ...event,
    meta: { at: new Date().toISOString(), deliveryIds, id: `event_${deliveryIds[0]}` },
  };
}

function setup(optimistic = true) {
  const projection = new EveAgentProjection(defaultMessageReducer(), []);
  return { projection, submissions: new OptimisticMessageSubmissions(projection, optimistic) };
}

describe("OptimisticMessageSubmissions", () => {
  it("reconciles by delivery identity rather than message text", () => {
    const { projection, submissions } = setup();
    const id = submissions.submit({ message: "Same text" }, 0)!;
    const other = received("Same text", ["other"]);
    submissions.apply(other);
    expect(projection.data.messages.filter((message) => message.metadata?.optimistic)).toHaveLength(
      1,
    );

    const own = received("Same text", ["mine"]);
    submissions.apply(own);
    submissions.correlate(id, "mine", [other, own]);

    expect(projection.data.messages.filter((message) => message.role === "user")).toHaveLength(2);
    expect(projection.data.messages.some((message) => message.metadata?.optimistic)).toBe(false);
  });

  it("does not reconcile framework-authored task input", () => {
    const { projection, submissions } = setup();
    const id = submissions.submit({ message: "Hello" }, 0)!;
    submissions.correlate(id, "mine", []);
    const taskWake = received("Task completed", ["mine"]);
    submissions.apply({
      ...taskWake,
      data: { ...taskWake.data, kind: "execution.background_task" },
    });

    expect(projection.data.messages).toHaveLength(1);
    expect(projection.data.messages[0]?.metadata?.optimistic).toBe(true);
  });

  it("reconciles events that arrive before the POST response", () => {
    const { projection, submissions } = setup();
    const id = submissions.submit({ message: "Hello" }, 0)!;
    const event = received("Hello", ["mine"]);
    submissions.apply(event);

    expect(projection.data.messages.some((message) => message.metadata?.optimistic)).toBe(true);
    submissions.correlate(id, "mine", [event]);
    expect(projection.data.messages).toHaveLength(1);
    expect(projection.data.messages[0]?.metadata?.optimistic).toBeUndefined();
  });

  it.each([true, false])("folds coalesced deliveries once (optimistic=%s)", (optimistic) => {
    const { projection, submissions } = setup(optimistic);
    const first = submissions.submit({ message: "First" }, 0)!;
    const second = submissions.submit({ message: "Second" }, 0)!;
    submissions.correlate(first, "first", []);
    submissions.correlate(second, "second", []);

    submissions.apply(received("First\n\nSecond", ["first", "second"]));

    expect(projection.data.messages).toHaveLength(1);
    expect(projection.data.messages[0]?.parts).toContainEqual({
      state: "done",
      text: "First\n\nSecond",
      type: "text",
    });
  });

  it("places a coalesced follow-up before an already streamed reply", () => {
    const { projection, submissions } = setup();
    const first = submissions.submit({ message: "First" }, 0)!;
    submissions.correlate(first, "first", []);
    submissions.apply(received("First", ["first"]));
    const turnId = "turn_first";
    const reply = stampTestEvents([
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Reply",
        sequence: 1,
        stepIndex: 0,
        turnId,
      }),
    ])[0]!;
    submissions.apply(reply);

    const followUp = submissions.submit({ message: "Second" }, 2)!;
    submissions.correlate(followUp, "second", []);
    const secondReceived = received("Second", ["second"]);
    submissions.apply({
      ...secondReceived,
      data: { ...secondReceived.data, turnId },
    });

    expect(projection.data.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(projection.data.messages[1]?.parts).toContainEqual({
      state: "done",
      text: "Second",
      type: "text",
    });
  });

  it("keeps the active-turn optimistic correction above the reply through reconciliation", () => {
    const { projection, submissions } = setup();
    submissions.apply(received("First", ["first"]));
    const reply = stampTestEvents([
      createMessageCompletedEvent({
        finishReason: "stop",
        message: "Reply",
        sequence: 1,
        stepIndex: 0,
        turnId: "turn_first",
      }),
    ])[0]!;
    submissions.apply(reply);
    const followUp = submissions.submit({ message: "Second" }, 2, "turn_first")!;
    expect(projection.data.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    submissions.correlate(followUp, "second", []);
    const secondReceived = received("Second", ["second"]);
    submissions.apply({
      ...secondReceived,
      data: { ...secondReceived.data, turnId: "turn_first" },
    });
    expect(projection.data.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(projection.data.messages[1]?.metadata?.optimistic).toBeUndefined();
  });

  it("keeps a failed steered message ahead of its reply after replay", () => {
    const { projection, submissions } = setup();
    submissions.apply(received("First", ["first"]));
    submissions.apply(
      stampTestEvents([
        createMessageCompletedEvent({
          finishReason: "stop",
          message: "Reply",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_first",
        }),
      ])[0]!,
    );
    const id = submissions.submit({ message: "Second" }, 2, "turn_first")!;
    submissions.fail(new Error("Send failed"), id);
    expect(projection.data.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(projection.data.messages[1]?.metadata?.status).toBe("failed");
  });

  it("replaces a coalesced pair with one server bubble before the reply", () => {
    const { projection, submissions } = setup();
    submissions.apply(received("First", ["first"]));
    submissions.apply(
      stampTestEvents([
        createMessageCompletedEvent({
          finishReason: "stop",
          message: "Reply",
          sequence: 1,
          stepIndex: 0,
          turnId: "turn_first",
        }),
      ])[0]!,
    );
    const a = submissions.submit({ message: "Second" }, 2, "turn_first")!;
    const b = submissions.submit({ message: "Third" }, 2, "turn_first")!;
    submissions.correlate(a, "second", []);
    submissions.correlate(b, "third", []);
    const coalesced = received("Second\n\nThird", ["second", "third"]);
    submissions.apply({ ...coalesced, data: { ...coalesced.data, turnId: "turn_first" } });
    expect(projection.data.messages.map((message) => message.role)).toEqual([
      "user",
      "user",
      "assistant",
    ]);
    expect(projection.data.messages[1]?.parts).toContainEqual({
      state: "done",
      text: "Second\n\nThird",
      type: "text",
    });
  });

  it("keeps the confirmed user message at its server position after an unrelated assistant", () => {
    const { projection, submissions } = setup();
    const followUp = submissions.submit({ message: "Second" }, 0)!;
    submissions.correlate(followUp, "second", []);
    submissions.apply(
      stampTestEvents([
        createMessageCompletedEvent({
          finishReason: "stop",
          message: "Other reply",
          sequence: 0,
          stepIndex: 0,
          turnId: "other",
        }),
      ])[0]!,
    );
    submissions.apply(received("Second", ["second"]));
    expect(projection.data.messages.map((message) => message.role)).toEqual(["assistant", "user"]);
    expect(projection.data.messages[1]?.metadata?.optimistic).toBeUndefined();
  });

  it("reconciles structured file input without comparing summaries", () => {
    const { projection, submissions } = setup();
    const input = {
      message: [
        { text: "Review", type: "text" as const },
        {
          data: "data:text/plain;base64,SGVsbG8=",
          filename: "note.txt",
          mediaType: "text/plain",
          type: "file" as const,
        },
      ],
    };
    const id = submissions.submit(input, 0)!;
    submissions.correlate(id, "mine", []);
    submissions.apply(
      stampTestEvents([
        createMessageReceivedEvent({ message: input.message, sequence: 0, turnId: "turn_mine" }),
      ]).map((event) => ({ ...event, meta: { ...event.meta, deliveryIds: ["mine"] } }))[0]!,
    );

    expect(projection.data.messages).toHaveLength(1);
    expect(projection.data.messages[0]?.parts).toMatchObject([
      { state: "done", text: "Review", type: "text" },
      { filename: "note.txt", mediaType: "text/plain", type: "file" },
    ]);
  });

  it("uses the first message boundary only for a newly created session", () => {
    const { projection, submissions } = setup();
    const id = submissions.submit({ message: "Hello" }, 0);
    const event = received("Hello", []);
    submissions.apply(event);
    submissions.correlate(id, undefined, [event]);
    expect(projection.data.messages).toHaveLength(1);
    expect(projection.data.messages[0]?.metadata?.optimistic).toBeUndefined();
  });
});
