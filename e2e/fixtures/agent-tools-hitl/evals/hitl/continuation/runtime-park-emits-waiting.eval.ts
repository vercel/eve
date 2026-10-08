import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "A turn parked on a runtime workflow reports waiting on tasks before its result.",
  tags: ["hitl", "continuation", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start("Read the draft through a workflow.", scriptedSession);
    const turn = await expectReply(t, live, "Workflow draft status: ready.");
    turn.eventOrder([
      { type: "turn.started", count: 1 },
      { type: "turn.waiting", data: { on: "tasks" }, count: 1 },
      { type: "action.result", data: { result: { toolName: "workflow-draft" } }, count: 1 },
      { type: "turn.completed", count: 1 },
    ]);
  },
});
