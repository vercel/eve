import { describe, expect, it, vi } from "vitest";

import { promptQueueEvents, type PromptQueueState } from "#channel/prompt-queue.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { enterSessionProjection } from "#harness/session-machine/current.js";
import { recordLegacyEvent } from "#internal/testing/legacy-events.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { InputRequest } from "#shared/input.js";

const AT = { sequence: 0, stepIndex: 0, turnId: "turn_0" };

function question(requestId: string): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "ask" },
    display: "text",
    kind: "question",
    prompt: requestId,
    requestId,
  };
}

function requested(...requests: InputRequest[]): UnstampedMessageStreamEvent {
  return { data: { requests, ...AT }, type: "input.requested" };
}

function resolved(requestId: string): UnstampedMessageStreamEvent {
  return {
    data: { resolutions: [{ kind: "question", outcome: "answered", requestId }], ...AT },
    type: "input.resolved",
  };
}

/** Publishes `events` as a session does: each handler runs, then the session records it. */
async function publish(
  show: (channel: unknown, request: InputRequest) => Promise<boolean | void>,
  events: readonly UnstampedMessageStreamEvent[],
) {
  const handlers = promptQueueEvents(show) as Record<
    string,
    (data: unknown, channel: { state: PromptQueueState }) => Promise<void>
  >;
  const channel: { state: PromptQueueState } = { state: {} };
  const ctx = new ContextContainer();
  enterSessionProjection(ctx, undefined);
  await contextStorage.run(ctx, async () => {
    for (const event of events) {
      recordLegacyEvent(ctx, event);
      await handlers[event.type]?.("data" in event ? event.data : undefined, channel);
    }
  });
}

describe("promptQueueEvents", () => {
  it("shows a budget prompt ahead of a request already shown, then returns to it", async () => {
    const show = vi.fn(async (_channel: unknown, _request: InputRequest) => {});
    await publish(show, [
      requested(question("day")),
      requested({ ...question("budget"), kind: "session-limit" }),
      resolved("budget"),
    ]);
    expect(show.mock.calls.map(([, request]) => request.requestId)).toEqual([
      "day",
      "budget",
      "day",
    ]);
  });

  it("throws instead of showing nothing when the step's projection is missing", async () => {
    const show = vi.fn(async (_channel: unknown, _request: InputRequest) => {});
    const handlers = promptQueueEvents(show);
    const channel = { ctx: new ContextContainer(), state: { shownPromptId: "day" } };
    await expect(
      handlers["input.resolved"](
        { resolutions: [{ kind: "question", outcome: "answered", requestId: "day" }], ...AT },
        channel,
      ),
    ).rejects.toThrow("initialized projection");
    expect(channel.state.shownPromptId).toBe("day");
    expect(show).not.toHaveBeenCalled();
  });

  it("tries a request it could not show again on the next event", async () => {
    const show = vi
      .fn(async (_channel: unknown, _request: InputRequest): Promise<boolean> => true)
      .mockResolvedValueOnce(false);
    await publish(show, [requested(question("day")), requested(question("time"))]);
    expect(show.mock.calls.map(([, request]) => request.requestId)).toEqual(["day", "day"]);
  });
});
