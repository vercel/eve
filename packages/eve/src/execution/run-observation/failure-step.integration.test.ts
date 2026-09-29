import { describe, expect, it } from "vitest";

import { initialObservation } from "#execution/run-observation/state.js";
import { recordObservationFailureStep } from "#execution/run-observation/failure-step.js";
import { slackMessageVersion } from "#public/channels/slack/observation/plan.js";

describe("run observation failure reporting", () => {
  it("reports a confirmed receipt when its applied content is stale", async () => {
    const initial = initialObservation("root");
    const observation = {
      ...initial,
      sources: {
        ...initial.sources,
        root: {
          ...initial.sources.root!,
          completedReplies: { part: { turnId: "turn", text: "Latest answer" } },
        },
      },
    };
    const key = "root:reply:part";
    const report = await recordObservationFailureStep({
      reason: "expired",
      observation,
      receipts: {
        [key]: {
          key,
          state: "confirmed",
          providerMessageId: "123.456",
          appliedVersion: slackMessageVersion({
            key,
            kind: "reply",
            lifecycle: "retained",
            text: "Previous answer",
          }),
        },
      },
    });

    expect(report.undelivered).toEqual([{ key, state: "stale" }]);
  });
});
