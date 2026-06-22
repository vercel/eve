import { defineEval } from "eve/evals";

const DYNAMIC_SKILL_TOKEN = "dynamic-skill-ok-P4K9";

/**
 * Skill smoke eval:
 * a `defineDynamic` single-skill resolver (skills/dynamic-tenant-policy.ts)
 * resolves at session start; the load_skill result must carry the resolved
 * markdown body, which then shapes the reply.
 */
export default defineEval({
  description: "Skills smoke: dynamic single-skill resolution.",
  async test(t) {
    const turn = await t.send(
      "Please use the dynamic tenant policy skill and follow its instructions exactly.",
    );
    turn.expectOk();

    t.didNotFail();
    t.completed();
    t.loadedSkill("dynamic-tenant-policy", {
      output: new RegExp(DYNAMIC_SKILL_TOKEN, "u"),
    });
    t.messageIncludes(DYNAMIC_SKILL_TOKEN);
  },
});
