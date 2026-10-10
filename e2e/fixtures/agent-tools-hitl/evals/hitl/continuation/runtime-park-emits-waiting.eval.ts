import { defineEval } from "eve/evals";
import { scriptedSession, expectReply } from "./helpers.ts";

export default defineEval({
  description: "A turn parked on a runtime workflow pauses on its call before its result.",
  tags: ["hitl", "continuation", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await t.session();
    const live = await session.start("Read the draft through a workflow.", scriptedSession);
    const turn = await expectReply(t, live, "Workflow draft status: ready.");
    turn.eventOrder([
      { type: "turn.started", count: 1 },
      {
        type: "turn.paused",
        data: { awaiting: (awaiting) => awaiting.some((entry) => "callId" in entry) },
      },
      { type: "call.settled", data: { outcome: "completed" } },
      { type: "turn.settled", data: { outcome: "completed" }, count: 1 },
    ]);
    turn.calledTool("workflow-draft", { count: 1, status: "completed" });
  },
});
