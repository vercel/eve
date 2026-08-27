import { defineEval } from "eve/evals";

/**
 * Runs against the classifier directly — no Foreman in the loop. This is the
 * point of stations being top-level agents: each one has its own dev loop
 * and its own evals, exercised with `eve eval` from `agents/classifier/`.
 */
export default defineEval({
  description:
    "A concrete bug report classifies as an actionable bug without clarifying questions.",
  tags: ["fast"],
  async test(t) {
    await t.send(
      "Work item: clicking 'Export CSV' on the invoices page downloads an empty file. " +
        "Reproduces on Chrome and Firefox since Tuesday's deploy. Console shows a 500 " +
        "from /api/export.",
    );
    t.succeeded();
    t.replySatisfies("classified as an actionable bug", (reply) => {
      const parsed = JSON.parse(reply) as {
        type: string;
        actionable: boolean;
        needs_clarification: boolean;
      };
      return parsed.type === "bug" && parsed.actionable && !parsed.needs_clarification;
    });
  },
});
