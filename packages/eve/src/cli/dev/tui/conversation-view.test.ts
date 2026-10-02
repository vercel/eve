import { describe, expect, it } from "vitest";
import { stampTestEvent } from "#internal/testing/events.js";
import { createStepStartedEvent } from "#protocol/message.js";
import { tuiSessionReducer } from "./conversation-view.js";

const reportedModel = (modelId: string) =>
  tuiSessionReducer.reduce(
    tuiSessionReducer.initial(),
    stampTestEvent(
      createStepStartedEvent({ modelId, sequence: 0, stepIndex: 0, turnId: "turn_1" }),
      0,
    ),
  ).modelId;

describe("tuiSessionReducer", () => {
  it("keeps terminal controls out of the model id the status line prints", () => {
    expect(reportedModel("\u001b]0;renamed\u0007anthropic/claude\u001b[31m")).toBe(
      "anthropic/claude",
    );
    expect(reportedModel(" anthropic/claude \n\t fast ")).toBe("anthropic/claude fast");
    expect(reportedModel("\u001b[2J")).toBeUndefined();
    expect(reportedModel("m".repeat(300))).toHaveLength(256);
  });
});
