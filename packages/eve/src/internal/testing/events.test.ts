import { describe, expect, it } from "vitest";

import {
  containsEventSequence,
  captureTurnEvents,
  filterEventsByType,
  type WorkflowRunHandle,
} from "#internal/testing/events.js";

/**
 * Unit tests exercising the plain-data helpers on {@link events.ts}.
 *
 * The streaming capture helper is validated end-to-end against the real
 * workflow in the integration tier — see
 * `src/execution/workflow-entry.integration.test.ts`.
 */

describe("containsEventSequence", () => {
  it("returns true for an empty type list", () => {
    expect(containsEventSequence([], [])).toBe(true);
  });

  it("matches a contiguous sub-sequence", () => {
    const events = [
      { type: "turn.started" },
      { type: "message.completed", data: { message: "ok" } },
      { type: "turn.completed" },
    ] as const;

    expect(
      containsEventSequence(events as readonly any[], [
        "turn.started",
        "message.completed",
        "turn.completed",
      ]),
    ).toBe(true);
  });

  it("matches interleaved sub-sequences", () => {
    const events = [
      { type: "turn.started" },
      { type: "step.started" },
      { type: "message.completed", data: { message: "ok" } },
      { type: "step.completed" },
      { type: "turn.completed" },
    ] as const;

    expect(
      containsEventSequence(events as readonly any[], [
        "turn.started",
        "message.completed",
        "turn.completed",
      ]),
    ).toBe(true);
  });

  it("returns false when the order is wrong", () => {
    const events = [
      { type: "message.completed", data: { message: "ok" } },
      { type: "turn.started" },
    ] as const;

    expect(
      containsEventSequence(events as readonly any[], ["turn.started", "message.completed"]),
    ).toBe(false);
  });
});

describe("filterEventsByType", () => {
  it("returns only matching events with narrow typing", () => {
    const events = [
      { type: "turn.started" },
      { type: "message.completed", data: { message: "hello" } },
      { type: "message.completed", data: { message: "world" } },
      { type: "turn.completed" },
    ] as const;

    const messages = filterEventsByType(events as readonly any[], "message.completed");

    expect(messages).toHaveLength(2);
    expect(messages[0]?.data.message).toBe("hello");
  });
});

describe("captureTurnEvents", () => {
  it("throws when nextTurn is called after dispose", async () => {
    const encoder = new TextEncoder();
    const run = createStaticRun(
      encoder.encode(
        JSON.stringify({ type: "turn.started" }) +
          "\n" +
          JSON.stringify({ type: "session.waiting", data: { nextTokens: [] } }) +
          "\n",
      ),
    );
    const stream = captureTurnEvents(run);
    await stream.nextTurn();
    stream.dispose();

    await expect(stream.nextTurn()).rejects.toThrow("stream already disposed");
  });
});

function createStaticRun(bytes: Uint8Array): WorkflowRunHandle {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return {
    readable,
    async cancel() {},
  };
}
