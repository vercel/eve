import { describe, expect, it, vi } from "vitest";
import { runModelCallBatch } from "#execution/model-call-batching.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import { withOpenTurn } from "#internal/testing/session-machine.js";

describe("model call batching and steering", () => {
  it.each(["signal", "result"] as const)(
    "yields a completed tool result before another model call with pending steering (%s)",
    async (steeringSource) => {
      const steering = new AbortController();
      const session: HarnessSession = {
        sessionId: "session",
        continuationToken: "session",
        agent: { modelReference: { id: "mock" }, system: "Test", tools: [] },
        history: [],
        compaction: { threshold: 100000, recentWindowSize: 10 },
      };
      const completed: StepResult = {
        unreadInput: true,
        ...(steeringSource === "result" && { steered: true }),
        session: withOpenTurn(
          {
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
          { sequence: 0, turnId: "turn_0" },
        ),
      };
      const runStep = vi.fn(async () => {
        if (steeringSource === "signal") steering.abort();
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
    },
  );
});
