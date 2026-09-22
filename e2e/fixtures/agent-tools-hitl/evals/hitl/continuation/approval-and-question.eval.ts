import { defineEval } from "eve/evals";
import {
  scriptedSession,
  approveSavedChange,
  expectChangeStillUnexecuted,
  expectResponseReply,
  requestFrom,
} from "./helpers.ts";

export default defineEval({
  description:
    "Answering an approval and a later question in one delivery must finish both while another approval waits.",
  tags: ["hitl", "continuation", "regression", "input-response", "approval", "question"],
  timeoutMs: 60_000,
  async test(t) {
    // Given independent approvals A and B, followed by a color question.
    const first = await t.send("Prepare change A.", scriptedSession);
    const approvalA = requestFrom(first, "change-a");
    const session = first.session;
    const second = await session.send("Prepare change B, then acknowledge my decision.");
    const approvalB = requestFrom(second, "change-b");
    const third = await session.send("Ask which color to use, then read the draft status.");
    const question = requestFrom(third, "ask_question");

    // When one delivery approves A and answers the question, leaving B unanswered.
    const live = await session.startRespond([
      { requestId: approvalA.requestId, optionId: "approve" },
      { requestId: question.requestId, optionId: "red" },
    ]);

    // Then both requests resolve and both replies complete within this delivery's resumed turn.
    await expectResponseReply(t, live, "Change A resolved.", approvalA.requestId);
    const reply = await expectResponseReply(t, live, "Draft status: ready.", question.requestId);
    reply.event("turn.started", { count: 1 });
    reply.event("turn.completed", { count: 1 });
    reply.calledTool("change-a", { status: "completed", output: { executions: 1 }, count: 1 });
    reply.calledTool("read-draft", { status: "completed", count: 1 });
    reply.eventsSatisfy("Both saved requests resolve", (events) =>
      [approvalA.requestId, question.requestId].every((requestId) =>
        events.some(
          (event) =>
            event.type === "input.resolved" &&
            event.data.resolutions.some((resolution) => resolution.requestId === requestId),
        ),
      ),
    );
    expectChangeStillUnexecuted(session, "change-b");
    await approveSavedChange(t, session, approvalB);
  },
});
