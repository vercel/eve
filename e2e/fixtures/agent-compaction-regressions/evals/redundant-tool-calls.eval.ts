import { defineEval } from "eve/evals";

import { HANDOFF_REFERENCE, REVIEW_REFERENCE } from "../release-reports";

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
      output: { completed: true, reportId: REVIEW_REFERENCE, status: "completed" },
    });
    t.calledTool("prepare-handoff", {
      count: 1,
      input: { reviewId: REVIEW_REFERENCE },
      output: { completed: true, reportId: HANDOFF_REFERENCE, status: "completed" },
    });
    t.event("compaction.completed", { count: (count) => count >= 2 });
    t.messageIncludes(REVIEW_REFERENCE);
    t.messageIncludes(HANDOFF_REFERENCE);
    t.noFailedActions();

    t.calledTool("inspect-repository", { count: 1 }).soft().label("no repeated inspection");
    t.calledTool("prepare-handoff", { count: 1 }).soft().label("no repeated handoff");
    t.event("compaction.completed", { count: 2 }).soft().label("compaction efficiency");
  },
});
