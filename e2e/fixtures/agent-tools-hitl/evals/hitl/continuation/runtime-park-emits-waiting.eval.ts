import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description:
    "A turn waiting on a runtime workflow announces no pause: only a person's wait is a fact.",
  tags: ["hitl", "continuation", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start("Read the draft through a workflow.", scriptedSession);
    const turn = await expectReply(t, live, "Workflow draft status: ready.");
    turn.eventOrder([
      { type: "turn.started", count: 1 },
      { type: "call.settled", data: { outcome: "completed" } },
      { type: "turn.settled", data: { outcome: "completed" }, count: 1 },
    ]);
    turn.calledTool("workflow-draft", { count: 1, status: "completed" });
    turn.notEvent("turn.paused");
  },
});
