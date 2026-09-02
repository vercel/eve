import { describe, expect, it } from "vitest";

import {
  consumeDeferredStepInput,
  hasDeferredStepInput,
  queueDeferredStepInput,
} from "#harness/hitl/deferred-step-input.js";
import type { HarnessSession } from "#harness/types.js";

function session(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: { modelReference: {} as never, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 0.8 },
    continuationToken: "test",
    history: [],
    sessionId: "session-1",
    state,
  };
}

describe("deferred step input", () => {
  it("reports whether deferred input exists", () => {
    const empty = session();
    expect(hasDeferredStepInput(empty)).toBe(false);

    const queued = queueDeferredStepInput(empty, { message: "hello" });
    expect(hasDeferredStepInput(queued)).toBe(true);
  });

  it("consumes deferred input when there is no fresh input", () => {
    const queued = queueDeferredStepInput(session(), { message: "hello" });
    const result = consumeDeferredStepInput({ session: queued });

    expect(result.input).toEqual({ message: "hello" });
    expect(hasDeferredStepInput(result.session)).toBe(false);
  });

  it("coalesces deferred input with fresh input", () => {
    const queued = queueDeferredStepInput(session(), { context: ["a"], message: "hello" });
    const result = consumeDeferredStepInput({
      input: { context: ["b"], inputResponses: [{ optionId: "x", requestId: "r1" }] },
      session: queued,
    });

    expect(result.input).toEqual({
      context: ["a", "b"],
      inputResponses: [{ optionId: "x", requestId: "r1" }],
      message: "hello",
    });
    expect(hasDeferredStepInput(result.session)).toBe(false);
  });

  it("prefers current input without consuming deferred input when requested", () => {
    const queued = queueDeferredStepInput(session(), { message: "older" });
    const result = consumeDeferredStepInput({
      input: { message: "newer" },
      preferCurrentInput: true,
      session: queued,
    });

    expect(result.input).toEqual({ message: "newer" });
    expect(hasDeferredStepInput(result.session)).toBe(true);
  });

  it("queues multiple deferred inputs by coalescing them", () => {
    const first = queueDeferredStepInput(session(), { context: ["a"], message: "hello" });
    const second = queueDeferredStepInput(first, {
      context: ["b"],
      inputResponses: [{ optionId: "approve", requestId: "r1" }],
    });
    const result = consumeDeferredStepInput({ session: second });

    expect(result.input).toEqual({
      context: ["a", "b"],
      inputResponses: [{ optionId: "approve", requestId: "r1" }],
      message: "hello",
    });
  });
});
