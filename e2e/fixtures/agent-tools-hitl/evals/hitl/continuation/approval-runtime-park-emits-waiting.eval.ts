import { defineEval } from "eve/evals";
import { scriptedSession, requestFrom } from "./helpers.ts";

export default defineEval({
  description:
    "An approval beside a running workflow reports tasks, then input when the workflow settles.",
  tags: ["hitl", "continuation", "workflow", "input-response"],
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send(
      "Prepare change A and read the workflow draft together.",
      scriptedSession,
    );
    requestFrom(turn, "change-a");
    turn.eventOrder([
      { type: "turn.started", count: 1 },
      { type: "turn.waiting", data: { on: "tasks" }, count: 1 },
      { type: "action.result", data: { result: { toolName: "workflow-draft" } }, count: 1 },
      { type: "input.requested", count: 1 },
      { type: "turn.waiting", data: { on: "input" }, count: 1 },
    ]);
    turn.notEvent("turn.completed");
  },
});
