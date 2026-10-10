import { describe, expect, it } from "vitest";

import { preserveCancelledTurnMessage } from "#execution/cancelled-turn-message.js";
import { markFrameworkStepInput } from "#harness/messages.js";
import type { HarnessSession } from "#harness/types.js";

function session(): HarnessSession {
  return {
    agent: {
      modelReference: { id: "test-model" },
      system: "You are a test assistant.",
      tools: [],
    },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "http:cancelled-turn-message",
    history: [],
    sessionId: "cancelled-turn-message",
  };
}

describe("preserveCancelledTurnMessage", () => {
  it("preserves the framework kind on a cancelled framework delivery", async () => {
    const result = await preserveCancelledTurnMessage(
      session(),
      markFrameworkStepInput(
        { message: "Continue the interrupted turn." },
        "execution.continuation",
      ),
    );

    expect(result.history).toEqual([
      {
        content: "Continue the interrupted turn.",
        kind: "execution.continuation",
        role: "user",
      },
    ]);
  });

  it("brands a cancelled real user message as user", async () => {
    const result = await preserveCancelledTurnMessage(session(), {
      message: "Cancel this turn.",
    });

    expect(result.history).toEqual([{ content: "Cancel this turn.", kind: "user", role: "user" }]);
  });
});
