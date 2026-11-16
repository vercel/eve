import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A work item enters the pipeline through typed triage before any analysis happens, and an explicit stop-after-analysis instruction keeps the implementer idle.",
  tags: ["slow", "needs-connect"],
  async test(t) {
    await t.send(
      "Work item: users report that password reset emails sometimes arrive twice. Triage this and produce the implementation plan, but stop after analysis and report the plan to me; do not implement anything yet."
    );
    t.succeeded();
    t.calledTool("triage_work_item");
    t.calledAgent("analyst");
    t.calledAgent("implementer", { count: 0 });
    t.eventsSatisfy("triage runs before the analyst", (events) => {
      const calls = events.filter((event) => event.type === "call.requested");
      const triage = calls.findIndex(
        (event) => event.data.capability.name === "triage_work_item"
      );
      const analyst = calls.findIndex(
        (event) => event.data.capability.name === "analyst"
      );
      return triage !== -1 && analyst > triage;
    });
  },
});
