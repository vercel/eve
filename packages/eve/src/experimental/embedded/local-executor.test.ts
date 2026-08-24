import { describe, expect, it } from "vitest";

import {
  createResultCompletedEvent,
  createSessionCompletedEvent,
  createSessionFailedEvent,
  createSessionWaitingEvent,
  stampMessageStreamEvent,
  type MessageStreamEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import {
  canonicalizeEmbeddedInput,
  EmbeddedLocalExecutorError,
  projectEmbeddedRunEvents,
} from "./local-executor.js";

function eventStream(
  events: readonly UnstampedMessageStreamEvent[],
): ReadableStream<MessageStreamEvent> {
  return new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(stampMessageStreamEvent(event));
      controller.close();
    },
  });
}

function resultEvent(result: string) {
  return createResultCompletedEvent({ result, sequence: 1, stepIndex: 0, turnId: "turn_1" });
}

describe("embedded local executor input projection", () => {
  it("serializes JSON with recursively sorted object keys", () => {
    expect(canonicalizeEmbeddedInput({ z: 1, a: { y: 2, b: 3 }, list: [{ d: 4, c: 5 }] })).toBe(
      '{"a":{"b":3,"y":2},"list":[{"c":5,"d":4}],"z":1}',
    );
  });
});

describe("embedded local executor event projection", () => {
  it("returns exactly one structured result at terminal completion", async () => {
    await expect(
      projectEmbeddedRunEvents(
        eventStream([resultEvent("triaged"), createSessionCompletedEvent()]),
      ),
    ).resolves.toMatchObject({ result: "triaged" });
  });

  it("rejects a result that is not valid JSON", async () => {
    const event = createResultCompletedEvent({
      result: Number.NaN as never,
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    });

    await expect(
      projectEmbeddedRunEvents(eventStream([event, createSessionCompletedEvent()])),
    ).rejects.toMatchObject({
      code: "embedded_run_invalid_result",
      name: "EmbeddedLocalExecutorError",
    } satisfies Partial<EmbeddedLocalExecutorError>);
  });

  it.each([
    {
      code: "embedded_run_waiting",
      events: [createSessionWaitingEvent("session_1")],
    },
    {
      code: "embedded_run_failed",
      events: [
        createSessionFailedEvent({
          code: "model_failed",
          message: "Model failed.",
          sessionId: "session_1",
        }),
      ],
    },
    {
      code: "embedded_run_missing_result",
      events: [createSessionCompletedEvent()],
    },
    {
      code: "embedded_run_duplicate_result",
      events: [resultEvent("first"), resultEvent("second")],
    },
    {
      code: "embedded_run_nonterminal",
      events: [resultEvent("orphaned")],
    },
  ])("rejects $code", async ({ code, events }) => {
    await expect(projectEmbeddedRunEvents(eventStream(events))).rejects.toMatchObject({
      code,
      name: "EmbeddedLocalExecutorError",
    } satisfies Partial<EmbeddedLocalExecutorError>);
  });
});
