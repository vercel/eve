import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "A user creates a scheduled request through the experimental collection and approves its persistence.",
  async test(t) {
    const pending = await t.send(
      'Alice is organizing a recurring review. Use schedule__requests__create to save "Review open incidents" as incident-review with cron "0 9 * * *" in UTC. This demonstration records the task only; no notification destination is requested.',
    );
    pending.calledTool("schedule__requests__create", { status: "pending", count: 1 });
    const approval = pending.session.requireInputRequest({
      display: "confirmation",
      toolName: "schedule__requests__create",
    });
    const approved = await pending.session.respond([
      { requestId: approval.requestId, optionId: "approve" },
    ]);
    approved.expectOk();
    approved.calledTool("schedule__requests__create", {
      output: /incident-review/,
    });
    t.succeeded();
  },
});
