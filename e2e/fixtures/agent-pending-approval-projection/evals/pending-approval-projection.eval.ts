import { defineEval } from "eve/evals";

const INITIAL_TARGET = "Alice";
const CORRECTED_TARGET = "Bob";

export default defineEval({
  tags: ["real-model"],
  description:
    "An updated plan uses the latest requested target while an earlier action awaits approval.",
  async test(t) {
    const turn = await t.send(
      [
        `The change plan should now target ${CORRECTED_TARGET} instead of ${INITIAL_TARGET}.`,
        "Please update the plan and send the revised version.",
      ].join("\n"),
      {
        clientContext: [
          `Alice asked for a change plan targeting ${INITIAL_TARGET}.`,
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
