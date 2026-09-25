import { defineEval } from "eve/evals";
import {
  scriptedSession,
  expectChangeStillUnexecuted,
  expectResponseReply,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "Control: a workflow finishing beside an approval cannot bypass that turn's approval.",
  tags: ["hitl", "continuation", "control", "user-message", "input-response", "workflow"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a fresh session with no pending input.
    // When the user requests change A and a workflow read together.
    const parked = await t.send(
      "Prepare change A and read the workflow draft together.",
      scriptedSession,
    );
    // Then A still requires approval and the workflow cannot produce a final reply alone.
    const approval = requestFrom(parked, "change-a");
    parked.calledTool("workflow-draft", { status: "completed", count: 1 });
    parked.notEvent("message.completed");
    const session = parked.session;
    expectChangeStillUnexecuted(session);

    // When the user approves A.
    const live = await session.startRespond([
      { requestId: approval.requestId, optionId: "approve" },
    ]);

    // Then both tools execute once and their combined reply completes the resumed turn.
    await expectResponseReply(
      t,
      live,
      "Workflow draft status: ready. Change A resolved.",
      approval.requestId,
    );
    session.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    session.calledTool("workflow-draft", { status: "completed", count: 1 });
  },
});
