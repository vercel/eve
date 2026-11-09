import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: approvals use structured controls, not text replies.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "text-approve".');
    const session = parked.session;
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = session.requireInteraction({
      display: "confirmation",
      toolName: "guarded-echo",
    });
    const cancelled = await session.respond([
      { optionId: "deny", interactionId: approval.interactionId },
    ]);
    cancelled.expectOk();
    t.succeeded();
  },
});
