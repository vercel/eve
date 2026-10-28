import { defineEval } from "eve/evals";

const DYNAMIC_REFERENCE = "Dynamic policy reference fixture.";

/**
 * A dynamic skill's supporting files aren't stored with the session: eve renders them where a
 * sandbox needs them. The first turn renders the skill without touching the sandbox, so the
 * second turn's read creates it, and in a process that rendered nothing (as under
 * EVE_REACTIONS_COLD=1), eve renders the skill again from its record to write the file.
 */
export default defineEval({
  description:
    "A dynamic skill's supporting file reaches a sandbox created after the skill rendered.",
  async test(t) {
    const first = await t.send("Alice says hello.");
    first.expectOk();
    first.usedNoTools();

    const second = await first.session.send(
      "Alice wants to check the policy reference in her fresh workspace. Use bash to read $HOME/.agents/skills/dynamic-tenant-policy/references/policy.md and report its text. The check is labelled SKILL-FILE dynamic-tenant-policy references/policy.md",
    );
    second.expectOk();
    second.calledTool("bash", { output: new RegExp(DYNAMIC_REFERENCE, "u"), status: "completed" });
  },
});
