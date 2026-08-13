import { defineEval } from "eve/evals";

const TOKEN = "approval-resume-token-T8K2";

export default defineEval({
  tags: ["real-model"],
  metadata: { transition: "owner.approval.response.settle-allow" },
  description: "ToolContext.getToken remains available when an approval-gated tool resumes.",
  async test(t) {
    const parked = await t.send(
      'Call approval-auth-probe exactly once with marker "after-approval". After it returns, include its token verbatim.',
    );
    t.requireInputRequest({
      optionIds: ["approve", "deny"],
      toolName: "approval-auth-probe",
    });

    const resumed = await t.respondAll("approve");
    resumed.expectOk();
    resumed.event("session.waiting", { count: 1 });
    resumed.calledTool("approval-auth-probe", {
      input: { marker: "after-approval" },
      output: { marker: "after-approval", token: TOKEN },
      count: 1,
    });
    resumed.messageIncludes(TOKEN);

    const followUp = await t.send("Do not call tools. Reply with exactly AUTH-PROBE-FOLLOW-UP-OK.");
    followUp.expectOk();
    if (followUp.sessionId !== parked.sessionId) throw new Error("Auth probe changed session ID.");
    followUp.event("message.completed", { count: 1 });
    followUp.event("session.waiting", { count: 1 });
    followUp.messageIncludes("AUTH-PROBE-FOLLOW-UP-OK");
    followUp.usedNoTools();
  },
});
