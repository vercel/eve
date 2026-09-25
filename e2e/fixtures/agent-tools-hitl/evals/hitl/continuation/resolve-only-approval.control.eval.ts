import { defineEval } from "eve/evals";
import { scriptedSession, expectResponseReply, requestFrom } from "./helpers.ts";

export default defineEval({
  description: "Control: resolving the only approval runs its tool, reads the status, and replies.",
  tags: ["hitl", "continuation", "control", "input-response", "approval"],
  timeoutMs: 60_000,
  async test(t) {
    // Given only B awaits approval and must be followed by a read.
    const parked = await t.send("Prepare change B, then read the draft status.", scriptedSession);
    const approval = requestFrom(parked, "change-b");

    // When the user approves B.
    const live = await parked.session.startRespond([
      { requestId: approval.requestId, optionId: "approve" },
    ]);

    // Then B executes once, the draft is read, and the reply completes.
    const reply = await expectResponseReply(t, live, "Draft status: ready.", approval.requestId);
    reply.calledTool("change-b", { status: "completed", output: { executions: 1 }, count: 1 });
    reply.calledTool("read-draft", { status: "completed", count: 1 });
  },
});
