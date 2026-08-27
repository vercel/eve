import { defineEval } from "eve/evals";
import { GITHUB_WRITE_TOOLS } from "./helpers.js";

export default defineEval({
  description:
    "A greeting doesn't spin up the factory line: the agent answers directly, delegates nothing to the implementer, and writes nothing to GitHub.",
  tags: ["fast"],
  async test(t) {
    await t.send("Hi! What are you and what can you do for me on this repository?");
    t.succeeded();
    t.calledSubagent("implementer", { count: 0 });
    t.calledSubagent("reviewer", { count: 0 });
    for (const tool of GITHUB_WRITE_TOOLS) {
      t.notCalledTool(tool);
    }
  },
});
