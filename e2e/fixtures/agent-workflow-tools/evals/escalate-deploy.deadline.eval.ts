import { defineEval } from "eve/evals";

/**
 * `ask` returns a promise, so the question composes with `Promise.race` — here
 * against a long deadline. The human answers, the race resolves to their
 * choice, and the run settles the call.
 */
export default defineEval({
  description:
    "A workflow tool races ask against a deadline; the answer wins and settles the call.",
  async test(t) {
    const live = await t.start("WORKFLOW-ESCALATE-START");
    const requested = await live.waitForEvent("input.requested");
    const response = await t.target.fetch(`/eve/v1/session/${live.sessionId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        inputResponses: requested.data.requests.map((request) => ({
          requestId: request.requestId,
          optionId: "approve",
        })),
      }),
    });
    if (!response.ok) throw new Error("The approval was not accepted.");
    const answered = await live.result();
    answered.expectOk();
    answered.calledTool("escalate_deploy", { output: /"decided":"approved"/u });
    answered.messageIncludes("WORKFLOW-ESCALATE-RESULT");
    t.noFailedActions();
  },
});
