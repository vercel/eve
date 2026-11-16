import type { SessionStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";
import { satisfies } from "eve/evals/expect";
import { openInteractions } from "eve/events";

/**
 * Tool calls that read the repository's label vocabulary before a write.
 */
const VOCABULARY_READS = new Set([
  "github__getIssueContext",
  "github__listLabels",
]);

/**
 * Tool calls that can mirror the classification onto the issue. Both are
 * legitimate: `addLabels` writes labels alone, `updateIssue` batches them
 * with other fields, and pinning one would fail a correct run that chose
 * the other.
 */
const LABEL_WRITES = new Set(["github__addLabels", "github__updateIssue"]);

const toolCallOrder = (events: readonly SessionStreamEvent[]): string[] => {
  const order: string[] = [];
  for (const event of events) {
    if (
      event.type === "call.requested" &&
      event.data.capability.kind === "tool"
    ) {
      order.push(event.data.capability.name);
    }
  }
  return order;
};

export default defineEval({
  description:
    "Classifying a GitHub issue mirrors the result onto it as labels: the repo's vocabulary is read before any label write, and a label write (addLabels or updateIssue) is among the approvals the untrusted eval principal parks on; a progress comment may park alongside it. Needs at least one open issue (#1) on FACTORY_REPO.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    const turn = await t.send(
      "Run issue #1 on the repository through the classifier and mirror the classification onto the issue, then stop; do not run the analyst or any later station."
    );
    t.calledAgent("classifier");
    t.calledAgent("analyst", { count: 0 });
    t.calledAgent("implementer", { count: 0 });
    t.awaitingInput();
    t.check(
      openInteractions(turn.view)
        .filter((row) => row.request.kind === "approval")
        .map((row) => row.call?.name ?? ""),
      satisfies(
        (names: readonly string[]) =>
          names.some((name) => LABEL_WRITES.has(name)),
        "a label write is among the pending approvals"
      )
    );
    t.eventsSatisfy(
      "reads the repo's label vocabulary before writing labels",
      (events) => {
        const order = toolCallOrder(events);
        const writeAt = order.findIndex((name) => LABEL_WRITES.has(name));
        const readAt = order.findIndex((name) => VOCABULARY_READS.has(name));
        return writeAt !== -1 && readAt !== -1 && readAt < writeAt;
      }
    );
  },
});
