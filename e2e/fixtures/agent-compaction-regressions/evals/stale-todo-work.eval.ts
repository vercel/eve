import { defineEval } from "eve/evals";

import { handoffReferences, reviewReferences } from "../release-reports";

export default defineEval({
  tags: ["real-model"],
  description: "A completed checkout review stays complete when the task board has a stale todo.",
  async test(t) {
    const turn = await t.send(
      "Review the checkout implementation and prepare a release handoff for the next maintainer. " +
        "Check pricing, inventory, order persistence, and customer notifications. The task board may be out of date; " +
        "use the completed review as the source of truth. Include the review and handoff record references in your final note.",
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("perform-source-analysis", {
      count: 1,
      input: { scope: "checkout" },
      output: { completed: true, reportId: reviewReferences.checkout, status: "completed" },
    });
    t.calledTool("prepare-handoff", {
      count: 1,
      input: { subject: "checkout", reviewId: reviewReferences.checkout },
      output: { completed: true, reportId: handoffReferences.checkout, status: "completed" },
    });
    t.event("compaction.completed", { count: (count) => count >= 2 });
    t.messageIncludes(reviewReferences.checkout);
    t.messageIncludes(handoffReferences.checkout);
    t.noFailedActions();

    t.calledTool("perform-source-analysis", { count: 1 }).soft().label("no repeated analysis");
    t.calledTool("prepare-handoff", { count: 1 }).soft().label("no repeated handoff");
    t.event("compaction.completed", { count: 2 }).soft().label("compaction efficiency");
  },
});
