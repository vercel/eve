import { defineEval } from "eve/evals";
import { scriptedSession, requestFrom } from "./helpers.ts";

export default defineEval({
  description:
    "An approval beside a running workflow pauses the turn on the approval once the workflow settles.",
  tags: ["hitl", "continuation", "workflow", "input-response"],
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send(
      "Prepare change A and read the workflow draft together.",
      scriptedSession,
    );
    const approval = requestFrom(turn, "change-a");
    turn.eventOrder([
      { type: "turn.started", count: 1 },
      { type: "call.settled", data: { outcome: "completed" } },
      {
        type: "turn.paused",
        data: {
          awaiting: (awaiting) =>
            awaiting.some(
              (entry) => "interactionId" in entry && entry.interactionId === approval.interactionId,
            ),
        },
      },
    ]);
    turn.calledTool("workflow-draft", { count: 1, status: "completed" });
    turn.notEvent("turn.settled");
    turn.event("turn.paused", { count: 1 });
  },
});
