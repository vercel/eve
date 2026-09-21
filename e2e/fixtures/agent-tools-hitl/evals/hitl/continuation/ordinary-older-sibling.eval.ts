import { defineEval } from "eve/evals";
import {
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectResponseReply,
  requestFrom,
  scriptedSession,
} from "./helpers.ts";

export default defineEval({
  description:
    "An older ordinary approval completes while a newer response-authorized approval stays answerable.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A awaits approval and a newer authorized change also awaits approval.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare an authorized change, then read the draft status.");
    const newer = requestFrom(second, "authorized-change");

    // When the user resolves the older request first.
    const live = await session.startRespond([
      { requestId: approvalA.requestId, optionId: "approve" },
    ]);
    const resolved = await expectResponseReply(t, live, "Change A resolved.", approvalA.requestId);

    // Then A executes once, and the newer request remains answerable.
    resolved.calledTool("change-a", {
      status: "completed",
      output: { executions: 1 },
      count: 1,
    });
    resolved.event("input.resolved", {
      data: { resolutions: [{ requestId: approvalA.requestId }] },
      count: 1,
    });
    expectChangeStillUnexecuted(session, "authorized-change");
    await approveSavedChange(t, session, newer);
  },
});
