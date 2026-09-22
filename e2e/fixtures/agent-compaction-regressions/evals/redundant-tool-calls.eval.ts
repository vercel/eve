import { defineEval } from "eve/evals";

import { handoffReferences, reviewReferences } from "../release-reports";

export default defineEval({
  tags: ["real-model"],
  description: "A repository review and release handoff survive compaction without repeated work.",
  async test(t) {
    const turn = await t.send(
      "Review the storefront repository and prepare a release handoff for the next maintainer. " +
        "Cover the catalog, cart, checkout, and order history, and call out the checks the maintainer should run before release. " +
        "Include the completed review and handoff record references in your final note.",
    );

    turn.expectOk();
    t.succeeded();
    t.calledTool("inspect-repository", {
      count: 1,
      input: { scope: "repository" },
      output: { completed: true, reportId: reviewReferences.repository, status: "completed" },
    });
    t.calledTool("prepare-handoff", {
      count: 1,
      input: { subject: "repository", reviewId: reviewReferences.repository },
      output: { completed: true, reportId: handoffReferences.repository, status: "completed" },
    });
    t.event("compaction.completed", { count: (count) => count >= 2 });
    t.messageIncludes(reviewReferences.repository);
    t.messageIncludes(handoffReferences.repository);
    t.noFailedActions();

    t.calledTool("inspect-repository", { count: 1 }).soft().label("no repeated inspection");
    t.calledTool("prepare-handoff", { count: 1 }).soft().label("no repeated handoff");
    t.event("compaction.completed", { count: 2 }).soft().label("compaction efficiency");
  },
});
