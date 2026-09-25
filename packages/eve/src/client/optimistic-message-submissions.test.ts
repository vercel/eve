import { describe, expect, it } from "vitest";
import { EveAgentProjection } from "#client/eve-agent-projection.js";
import { defaultMessageReducer } from "#client/message-reducer.js";
import { OptimisticMessageSubmissions } from "#client/optimistic-message-submissions.js";
import { stampTestEvents } from "#internal/testing/events.js";
import { createMessageReceivedEvent, type MessageStreamEvent } from "#protocol/message.js";

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

  it("never confirms a pending submission with delivered task results", () => {
    const { projection, submissions } = setup();
    submissions.submit({ message: "Remind me at 10" }, 0);
    const results = createMessageReceivedEvent({
      message:
        '<task_result id="remind-q4x1ze" tool="remind" status="completed">\nDone\n</task_result>',
      sequence: 1,
      taskIds: ["remind-q4x1ze"],
      turnId: "turn_1",
    });

    const reconciled = submissions.apply({
      ...results,
      meta: { at: new Date().toISOString(), id: "event_results" },
    });

    expect(reconciled).toBeUndefined();
    expect(projection.data.messages).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ optimistic: true }) }),
    ]);
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
