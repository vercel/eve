import { defineEval } from "eve/evals";

const DYNAMIC_REFERENCE = "Dynamic policy reference fixture.";

/**
 * Skill smoke eval:
 * the dynamic tenant policy package (skills/dynamic-tenant-policy.ts) ships a
 * supporting file. Its markdown is served from session state, while the file
 * must still be written to the sandbox skill root for the model to read.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Skills smoke: dynamic skill supporting file access.",
  async test(t) {
    await t.send(
      "Alice is reviewing the tenant setup. Please use the read_file tool to read " +
        "$HOME/.agents/skills/dynamic-tenant-policy/references/policy.md, then tell her what it says.",
    );

    t.succeeded();
    t.calledTool("read_file", { output: new RegExp(DYNAMIC_REFERENCE, "u") });
  },
});
