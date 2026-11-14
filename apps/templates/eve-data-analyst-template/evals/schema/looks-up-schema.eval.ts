import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Explores a table the metric definitions don't cover before querying it, instead of guessing column names.",
  async test(t) {
    await t.send(
      "What's the average invoice total by billing interval for invoices issued in the last 90 days?"
    );
    t.succeeded();
    t.calledTool("describe_schema");
    t.calledTool("run_sql");
    t.toolOrder(["describe_schema", "run_sql"]);
  },
});
