import { defineEval } from "eve/evals";

/**
 * `ask` returns the hook, so the question composes with `Promise.race` — here
 * against a long deadline. The human answers, the race resolves to their
 * choice, and the run settles the call.
 */
export default defineEval({
  description:
    "A workflow tool races ask against a deadline; the answer wins and settles the call.",
  async test(t) {
    const parked = await t.send("WORKFLOW-ESCALATE-START");
    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "escalate_deploy",
    });
    parked.calledTool("escalate_deploy", { status: "pending", count: 1 });

    const answered = await t.respondAll("approve");
    answered.expectOk();
    answered.calledTool("escalate_deploy", { output: /"decided":"approved"/u });
    answered.messageIncludes("WORKFLOW-ESCALATE-RESULT");
    t.noFailedActions();
  },
});
