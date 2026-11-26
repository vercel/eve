import { describe, expect, it } from "vitest";

import { formatEvalTranscript } from "#evals/session-content.js";
import { stampTestEvent } from "#internal/testing/events.js";

describe("formatEvalTranscript", () => {
  it("omits empty text from tool-only imported history entries while keeping text entries in order", () => {
    const events = [
      stampTestEvent(
        {
          data: {
            deliveryId: "d_0",
            history: [
              { role: "user", text: "Is ticket T-1 open?" },
              {
                parts: [{ name: "lookup_ticket", output: { status: "open" }, type: "tool" }],
                role: "assistant",
                text: "",
              },
              {
                parts: [
                  { name: "list_notes", output: [], type: "tool" },
                  { text: "T-1 is open.", type: "text" },
                ],
                role: "assistant",
                text: "T-1 is open.",
              },
            ],
            parts: [{ kind: "text", text: "Thanks." }],
            turnId: "turn_0",
          },
          scope: { turnId: "turn_0" },
          type: "delivery.consumed",
        },
        1,
      ),
      stampTestEvent(
        {
          data: {
            kind: "text",
            partId: "p_0",
            phase: "reply",
            runId: "run_0",
            value: "You're welcome.",
          },
          scope: { runId: "run_0", turnId: "turn_0" },
          type: "content.completed",
        },
        2,
      ),
    ];

    expect(formatEvalTranscript(events)).toBe(
      [
        "User:\nIs ticket T-1 open?",
        "Assistant:\nT-1 is open.",
        "User:\nThanks.",
        "Assistant:\nYou're welcome.",
      ].join("\n\n"),
    );
  });
});
