import { defineEval } from "eve/evals";

const DYNAMIC_REFERENCE = "Dynamic policy reference fixture.";

/**
 * Skill smoke eval:
 * the dynamic tenant policy package (skills/dynamic-tenant-policy.ts) ships a
 * supporting file. Its markdown is served from session state, while the file
 * must still be readable from the sandbox in a later durable step.
 */
export default defineEval({
  tags: ["real-model"],
  description: "Skills smoke: dynamic skill supporting file access.",
  async test(t) {
    await t.send(
      "Alice is reviewing the tenant setup. Please use the read_skill_file tool to read " +
        "references/policy.md from the dynamic-tenant-policy skill, then tell her what it says.",
    );

    t.succeeded();
    t.calledTool("read_skill_file", {
      input: { path: "references/policy.md", skill: "dynamic-tenant-policy" },
      output: new RegExp(DYNAMIC_REFERENCE, "u"),
    });
  },
});
