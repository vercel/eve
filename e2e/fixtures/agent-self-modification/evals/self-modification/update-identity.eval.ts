import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod edits the agent's own instructions for an identity change instead of scaffolding itself.",
  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      const run = await selfMod.request(
        "Alice is setting this agent up for a history class. Please update your instructions to say you're a historian.",
      );
      run.child.notCalledTool("registry_add");
      const instructions = await selfMod.readSource("instructions.md");
      if (!/historian/i.test(instructions)) {
        throw new Error("instructions.md does not describe the agent as a historian.");
      }
      await selfMod.assertOnlyChanged(["instructions.md"]);
      t.succeeded();
    });
  },
});
