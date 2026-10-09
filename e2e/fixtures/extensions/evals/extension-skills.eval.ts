import { requireMockModel } from "@eve-e2e/config/mock-script";
import { defineEval } from "eve/evals";

const TOOLKIT_INCIDENT_TOKEN = "toolkit-incident-dynamic-ok-7T2X";

/**
 * Extension skills load through eve__skill({ name }) under their mount prefix:
 * a packaged static skill, and a dynamic map entry that composes under each
 * mount (`toolkit__incident`, `toolkit-alt__incident`) instead of its bare key.
 */
export default defineEval({
  description: "eve__skill({ name }) loads static and dynamic extension skills under their mounts.",
  async test(t) {
    requireMockModel(t);

    const turn = await t.send(
      "SKILL-LOAD toolkit__toolkit-guide toolkit__incident toolkit-alt__incident local-guide",
    );

    turn.expectOk();
    turn.noFailedActions();
    t.loadedSkill("toolkit__toolkit-guide", { count: 1, output: /# Toolkit triage/u });
    for (const mount of ["toolkit", "toolkit-alt"]) {
      t.loadedSkill(`${mount}__incident`, {
        count: 1,
        output: new RegExp(TOOLKIT_INCIDENT_TOKEN, "u"),
      });
    }
    t.loadedSkill("local-guide", { count: 1, output: /belongs to the consuming agent/u });
    t.messageIncludes(`${TOOLKIT_INCIDENT_TOKEN} ${TOOLKIT_INCIDENT_TOKEN}`);
  },
});
