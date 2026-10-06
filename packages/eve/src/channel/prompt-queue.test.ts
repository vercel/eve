import { describe, expect, it, vi } from "vitest";

import { promptQueueEvents, type PromptQueueState } from "#channel/prompt-queue.js";
import type { InputRequest } from "#shared/input.js";

function question(requestId: string): InputRequest {
  return {
    action: { callId: requestId, input: {}, kind: "tool-call", toolName: "ask" },
    display: "text",
    kind: "question",
    prompt: requestId,
    requestId,
  };
}

describe("promptQueueEvents", () => {
  it("shows a budget prompt ahead of a request already shown, then returns to it", async () => {
    const show = vi.fn(async (_channel: unknown, _request: InputRequest) => {});
    const events = promptQueueEvents(show);
    const channel: { state: PromptQueueState } = { state: {} };

    await events["input.requested"]({ requests: [question("day")] }, channel);
    await events["input.requested"](
      { requests: [{ ...question("budget"), kind: "session-limit" }] },
      channel,
    );
    await events["input.resolved"]({ resolutions: [{ requestId: "budget" }] }, channel);

    expect(show.mock.calls.map(([, request]) => request.requestId)).toEqual([
      "day",
      "budget",
      "day",
    ]);
  });
});
