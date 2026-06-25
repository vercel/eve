import { defineEval } from "eve/evals";

const HOUSE_RULES_OVERRIDE_TOKEN = "house-rules-dynamic-ok-M5T8";

/**
 * Skill conflict eval:
 * a dynamic resolver (skills/house-rules-override.ts) emits a skill named
 * `house-rules`, the same name as the authored `house-rules.md`. The dynamic
 * skill must win — loading `house-rules` returns the dynamic body, never the
 * authored one.
 */
export default defineEval({
  description: "Skills smoke: a dynamic skill overrides a same-named authored skill.",
  async test(t) {
    await t.send("Please use the house rules skill and follow its instructions exactly.");

    t.succeeded();
    t.loadedSkill("house-rules", { output: new RegExp(HOUSE_RULES_OVERRIDE_TOKEN, "u") });
    t.messageIncludes(HOUSE_RULES_OVERRIDE_TOKEN);
  },
});
