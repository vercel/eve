import { defineEval } from "eve/evals";
import {
  scriptedSession,
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectResponseReply,
  expectToolResult,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "authorized-sibling: resolving the current request must finish its work while change A still waits.",
  tags: ["hitl", "continuation", "regression", "input-response", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A awaits approval and a separate authorized change must be followed by a read.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare an authorized change, then read the draft status.");
    const current = requestFrom(second, "authorized-change");

    // When the authorized responder approves the separate change.
    const live = await session.startRespond([
      { requestId: current.requestId, optionId: "approve" },
    ]);

    // Then authorization settles, the change executes once, and the read gets a reply; A stays answerable.
    await expectToolResult(t, live, "read-draft");
    const reply = await expectResponseReply(t, live, "Draft status: ready.", current.requestId);
    reply.calledTool("authorized-change", {
      status: "completed",
      output: { executions: 1 },
      count: 1,
    });
    reply.event("approval.settled", {
      data: { requestId: current.requestId, outcome: "approved" },
      count: 1,
    });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approvalA);
  },
});
