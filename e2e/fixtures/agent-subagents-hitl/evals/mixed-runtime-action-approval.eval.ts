import { defineEval } from "eve/evals";

const COLLISION_MARKER = "MIXED-PARK-COMPLETE-7K2M";

/**
 * Regression coverage for https://github.com/vercel/eve/issues/1201.
 *
 * One model step requests an approval-gated tool and a subagent together.
 * The child may finish first, but the root turn must retain the approval and
 * re-park instead of resuming the model with an unanswered tool call.
 */
export default defineEval({
  description: "A root approval and subagent call from one model step both survive parking.",
  async test(t) {
    const parked = await t.send(
      [
        `Call the collision-gate tool with marker "${COLLISION_MARKER}" and the collision-child subagent in the same assistant response.`,
        "Do not wait for one call before making the other.",
        `After both results arrive, reply with exactly ${COLLISION_MARKER}.`,
      ].join("\n"),
    );

    parked.calledTool("collision-gate", { count: 1, status: "pending" });
    parked.calledSubagent("collision-child", { count: 1, status: "completed" });
    parked.eventOrder([
      { type: "actions.requested" },
      { type: "input.requested" },
      { type: "subagent.completed" },
      { type: "session.waiting" },
    ]);
    t.requireInputRequest({ display: "confirmation", toolName: "collision-gate" });

    const resumed = await t.respondAll("approve");
    resumed.expectOk();
    resumed.messageIncludes(COLLISION_MARKER);

    t.succeeded();
    t.noFailedActions();
    t.calledTool("collision-gate", { count: 1, status: "completed" });
    t.calledSubagent("collision-child", { count: 1, status: "completed" });
  },
});
