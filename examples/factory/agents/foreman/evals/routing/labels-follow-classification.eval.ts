import type { MessageStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";

/**
 * Tool calls that read the repository's label vocabulary before a write.
 */
const VOCABULARY_READS = new Set(["github__getIssueContext", "github__listLabels"]);

/**
 * Tool calls that can mirror the classification onto the issue. Both are
 * legitimate: `addLabels` writes labels alone, `updateIssue` batches them
 * with other fields, and pinning one would fail a correct run that chose
 * the other.
 */
const LABEL_WRITES = new Set(["github__addLabels", "github__updateIssue"]);

const toolCallOrder = (events: readonly MessageStreamEvent[]): string[] => {
  const order: string[] = [];
  for (const event of events) {
    if (event.type !== "actions.requested") {
      continue;
    }
    for (const action of event.data.actions) {
      if (action.kind === "tool-call") {
        order.push(action.toolName);
      }
    }
  }
  return order;
};

export default defineEval({
  description:
    "Classifying a GitHub issue mirrors the result onto it as labels: the repo's vocabulary is read before any label write, and a label write (addLabels or updateIssue) is among the approvals the untrusted eval principal parks on; a progress comment may park alongside it. Needs at least one open issue (#1) on FACTORY_REPO.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "Run issue #1 on the repository through the classifier and mirror the classification onto the issue, then stop; do not run the analyst or any later station.",
    );
    t.calledSubagent("classifier");
    t.calledSubagent("analyst", { count: 0 });
    t.calledSubagent("implementer", { count: 0 });
    t.parked();
    t.check(
      t.pendingInputRequests.map((request) => request.action.toolName),
      satisfies(
        (names: readonly string[]) => names.some((name) => LABEL_WRITES.has(name)),
        "a label write is among the pending approvals",
      ),
    );
    t.eventsSatisfy("reads the repo's label vocabulary before writing labels", (events) => {
      const order = toolCallOrder(events);
      const writeAt = order.findIndex((name) => LABEL_WRITES.has(name));
      const readAt = order.findIndex((name) => VOCABULARY_READS.has(name));
      return writeAt !== -1 && readAt !== -1 && readAt < writeAt;
    });
  },
});
