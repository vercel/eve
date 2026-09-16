import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_triage_incident";

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod creates an incident-triage tool with typed inputs and deterministic priority rules.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      await selfMod.request(
        [
          `Alice's support team needs a reusable ${TOOL_NAME} action for classifying incidents in future conversations.`,
          "Accept impact as one of outage, degraded, or cosmetic; affectedUsers as an integer from 0 through 1000000; and dataAtRisk and workaroundAvailable as booleans.",
          "Assign P0 when data is at risk, or when an outage affects at least 100 users and no workaround exists.",
          "Otherwise assign P1 for any outage or when degraded service affects at least 1000 users; assign P2 for all other incidents.",
          "Return structured data with priority and responseMinutes, using 15 minutes for P0, 60 for P1, and 480 for P2.",
          "This action only classifies the supplied facts. It must not page responders, modify incidents, or contact external services.",
        ].join(" "),
      );
      await selfMod.readSource(`tools/${TOOL_NAME}.ts`);
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      await Promise.all(
        (
          [
            [
              {
                impact: "outage",
                affectedUsers: 100,
                dataAtRisk: false,
                workaroundAvailable: false,
              },
              "P0",
              15,
            ],
            [
              { impact: "cosmetic", affectedUsers: 1, dataAtRisk: true, workaroundAvailable: true },
              "P0",
              15,
            ],
            [
              {
                impact: "outage",
                affectedUsers: 99,
                dataAtRisk: false,
                workaroundAvailable: false,
              },
              "P1",
              60,
            ],
            [
              {
                impact: "degraded",
                affectedUsers: 1000,
                dataAtRisk: false,
                workaroundAvailable: true,
              },
              "P1",
              60,
            ],
            [
              {
                impact: "degraded",
                affectedUsers: 999,
                dataAtRisk: false,
                workaroundAvailable: false,
              },
              "P2",
              480,
            ],
            [
              {
                impact: "cosmetic",
                affectedUsers: 0,
                dataAtRisk: false,
                workaroundAvailable: false,
              },
              "P2",
              480,
            ],
          ] as const
        ).map(async ([input, priority, responseMinutes]) => {
          const turn = await selfMod.verify(
            `Classify this incident once with ${TOOL_NAME}: ${JSON.stringify(input)}. Report the classification without taking operational action.`,
          );
          turn.requireToolCall(TOOL_NAME, {
            input,
            output: { priority, responseMinutes },
          });
        }),
      );
      t.succeeded();
    });
  },
});
