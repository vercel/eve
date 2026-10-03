import { describe, expect, it } from "vitest";

import { AT, Turn } from "#internal/testing/human-input.js";

describe("HumanInput", () => {
  it("a turn with nothing open runs the model and leaves the rest of the session state alone", () => {
    const { humanInput } = Turn.idle();

    expect(humanInput.next()).toEqual({ run: "model" });
    expect(humanInput.write({ other: 1 })).toEqual({ other: 1 });
  });

  it("a request eve cannot ask for yet fails the turn instead of holding it", () => {
    const turn = Turn.idle().interrupt({
      at: AT,
      requests: [
        {
          action: { callId: "call-ask", input: {}, kind: "tool-call", toolName: "ask" },
          kind: "question",
          prompt: "Where should Bob deploy?",
          requestId: "ask",
        },
      ],
      route: { childContinuationToken: "bob-token" },
      type: "relayed.requested",
    });

    expect(turn.reported("turn.failed")).toEqual([
      expect.objectContaining({ code: "HUMAN_INPUT_UNAVAILABLE" }),
    ]);
    expect(turn.next()).toEqual({ run: "model" });
  });
});
