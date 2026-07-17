import { defineEval } from "eve/evals";

const TOOLKIT_SKILL_SCRIPT_TOKEN = "toolkit-skill-script-ok-8M3P";

export default defineEval({
  description: "A dist-only extension preserves JavaScript files inside packaged skills.",
  async test(t) {
    await t.send(
      "Use the toolkit guide skill to perform its packaged skill resource smoke test. Read the referenced script and report its token exactly.",
    );

    t.succeeded();
    t.loadedSkill("toolkit__toolkit-guide");
    t.messageIncludes(TOOLKIT_SKILL_SCRIPT_TOKEN);
  },
});
