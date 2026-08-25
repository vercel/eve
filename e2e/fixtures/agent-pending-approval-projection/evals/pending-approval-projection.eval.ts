import { defineEval } from "eve/evals";

const INITIAL_TARGET = "005INITIALTARGET";
const CORRECTED_TARGET = "005CORRECTEDTARGET";

export default defineEval({
  tags: ["real-model"],
  description: "A newer user correction supersedes the model-visible pending-approval projection.",
  async test(t) {
    const turn = await t.send(
      [
        "I am the original requester and confirm the intended outcome:",
        `set the target to explicit user id ${CORRECTED_TARGET}, not ${INITIAL_TARGET}.`,
        "The correction is authorized. Please revise and submit the plan now.",
      ].join("\n"),
      {
        clientContext: [
          `Original request: present a change plan targeting user id ${INITIAL_TARGET}.`,
          [
            "[Pending approvals]",
            "The following tool calls are awaiting approval and have not executed:",
            '{"requestId":"approval-1","toolName":"request-change-confirmation"}',
          ].join("\n"),
        ],
      },
    );

    turn.expectOk();
    turn.calledTool("emit-revised-change-plan", {
      input: { targetUserId: CORRECTED_TARGET },
      output: { emitted: true, targetUserId: CORRECTED_TARGET },
      count: 1,
    });
    turn.calledTool("ask_question", { status: "pending", count: 0 });
  },
});
