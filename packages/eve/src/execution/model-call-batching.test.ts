import { describe, expect, it, vi } from "vitest";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import type { HarnessSession, StepResult } from "#harness/types.js";

describe("model call batching and steering", () => {
  it("checkpoints a completed tool result instead of starting another model call with pending steering", async () => {
    const steering = new AbortController();
    const session: HarnessSession = {
      sessionId: "session",
      continuationToken: "session",
      agent: { modelReference: { id: "mock" }, system: "Test", tools: [] },
      history: [],
      compaction: { threshold: 100000, recentWindowSize: 10 },
    };
    const completed: StepResult = {
      next: async () => {
        throw new Error("The owner must apply steering first");
      },
      session: {
        ...session,
        history: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "saved",
                toolName: "save",
                output: { type: "text", value: "saved once" },
              },
            ],
          },
        ],
      },
    };
    const runStep = vi.fn(async () => {
      steering.abort();
      return completed;
    });
    expect(
      await runModelCallBatch({
        initialInput: undefined,
        initialSession: session,
        modelCallsPerStep: 4,
        steeringSignal: steering.signal,
        runStep,
      }),
    ).toBe(completed);
    expect(runStep).toHaveBeenCalledOnce();
  });
});
