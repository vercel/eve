import { defineEval } from "eve/evals";

const INITIAL_TARGET = "005INITIALTARGET";
const CORRECTED_TARGET = "005CORRECTEDTARGET";

export default defineEval({
  tags: ["real-model"],
  description: "A newer user correction supersedes the model-visible pending-approval projection.",
  async test(t) {
    const initial = await t.send(
      `Present a change plan targeting user id ${INITIAL_TARGET} by calling request-change-confirmation.`,
    );
    initial.calledTool("request-change-confirmation", {
      status: "pending",
      input: { targetUserId: INITIAL_TARGET },
      count: 1,
    });

    const corrected = await t.send(
      [
        "I am the original requester and confirm the intended outcome:",
        `set the target to explicit user id ${CORRECTED_TARGET}, not ${INITIAL_TARGET}.`,
        "The correction is authorized. Please revise and submit the plan now.",
      ].join("\n"),
    );

    corrected.expectOk();
    corrected.calledTool("emit-revised-change-plan", {
      input: { targetUserId: CORRECTED_TARGET },
      output: { emitted: true, targetUserId: CORRECTED_TARGET },
      count: 1,
    });
    corrected.calledTool("request-change-confirmation", { count: 0 });
    corrected.calledTool("ask_question", { status: "pending", count: 0 });
  },
});
