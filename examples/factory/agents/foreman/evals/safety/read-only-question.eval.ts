import { defineEval } from "eve/evals";
import { WRITE_TOOLS } from "../helpers.js";

export default defineEval({
  description:
    "A read-only question about the repository is answered with read tools alone: no GitHub write is attempted and no station with side effects runs.",
  tags: ["fast", "needs-connect"],
  async test(t) {
    await t.send(
      "What is this repository about, and what does its README say about getting started?",
    );
    t.succeeded();
    t.calledSubagent("implementer", { count: 0 });
    for (const tool of WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
