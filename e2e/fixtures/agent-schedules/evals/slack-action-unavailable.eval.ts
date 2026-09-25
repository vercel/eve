import { defineEval } from "eve/evals";

export default defineEval({
  tags: ["real-model"],
  description:
    "The optional Slack action reports unavailable caller context without claiming delivery.",
  async test(t) {
    const turn = await t.send(
      'Alice is checking the notification setup from this web conversation. Use send-slack once with target "requester" and message "The report is ready." If Slack context is unavailable, explain that no message was sent rather than choosing another destination.',
    );
    turn.calledTool("send-slack", { status: "failed", count: 1 });
    turn.notCalledTool("schedule__requests__create");
    turn.succeeded();
    t.succeeded();
  },
});
