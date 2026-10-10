import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

import { DYNAMIC_MULTI_ALPHA_TOKEN } from "../../agent/skills/dynamic-multi";
import { DYNAMIC_SKILL_TOKEN } from "../../agent/skills/dynamic-tenant-policy";
import { HOUSE_RULES_OVERRIDE_TOKEN } from "../../agent/skills/house-rules-override";

/**
 * eve__skill({ name }) loads dynamic skills by name: a single resolved skill
 * under its file slug, a map entry under its bare key, and a dynamic skill
 * that overrides the authored skill of the same name.
 */
export default defineEval({
  description: "eve__skill({ name }) loads dynamic skills, map entries, and dynamic overrides.",
  async test(t) {
    requireMockModel(t);

    const turn = await t.send("SKILL-LOAD dynamic-tenant-policy alpha house-rules");

    turn.expectOk();
    turn.noFailedActions();
    t.loadedSkill("dynamic-tenant-policy", {
      count: 1,
      output: new RegExp(DYNAMIC_SKILL_TOKEN, "u"),
    });
    t.loadedSkill("alpha", { count: 1, output: new RegExp(DYNAMIC_MULTI_ALPHA_TOKEN, "u") });
    t.loadedSkill("house-rules", {
      count: 1,
      output: new RegExp(HOUSE_RULES_OVERRIDE_TOKEN, "u"),
    });
    t.messageIncludes(
      `${DYNAMIC_SKILL_TOKEN} ${DYNAMIC_MULTI_ALPHA_TOKEN} ${HOUSE_RULES_OVERRIDE_TOKEN}`,
    );
  },
});
