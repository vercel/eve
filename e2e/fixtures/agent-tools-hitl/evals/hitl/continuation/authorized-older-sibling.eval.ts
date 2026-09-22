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
    "Approving the older response-authorized request completes its read and reply while newer approval A stays answerable.",
  tags: ["hitl", "continuation", "regression", "input-response", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given a response-authorized change is pending before an ordinary approval A.
    const first = await t.send(
      "Prepare an authorized change, then read the draft status.",
      scriptedSession,
    );
    const current = requestFrom(first, "authorized-change");
    const session = first.session;
    const second = await session.send("Prepare change A.");
    const approvalA = requestFrom(second, "change-a");

    // When the authorized responder approves the older change.
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
