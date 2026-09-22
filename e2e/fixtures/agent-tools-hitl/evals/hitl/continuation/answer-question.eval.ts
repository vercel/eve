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
    "answer-question: resolving the current request must finish its work while change A still waits.",
  tags: ["hitl", "continuation", "regression", "input-response", "question"],
  timeoutMs: 60_000,
  async test(t) {
    // Given A awaits approval and a later color question must be followed by a read.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Ask which color to use, then read the draft status.");
    const current = requestFrom(second, "ask_question");

    // When the user answers the color question.
    const live = await session.startRespond([{ requestId: current.requestId, optionId: "red" }]);

    // Then the read gets a completed reply; A stays unexecuted and answerable.
    await expectToolResult(t, live, "read-draft");
    const reply = await expectResponseReply(t, live, "Draft status: ready.", current.requestId);
    reply.calledTool("read-draft", { status: "completed", count: 1 });
    expectChangeStillUnexecuted(session);
    await approveSavedChange(t, session, approvalA);
  },
});
