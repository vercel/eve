import { defineEval } from "eve/evals";

import {
  loadRedeployState,
  REDEPLOY_FILE_PATH,
  REDEPLOY_SKILL_NAME,
  REDEPLOY_SKILL_TOKEN,
  requireRedeployPhase,
} from "./shared.js";

// Phase 3 (t3/t4), against the third deployment, which added a skill. Skills
// are materialized into the sandbox workspace resources, so the added skill
// changes the workspace content hash, which rotates the session sandbox key:
// the resumed session gets a fresh sandbox built from the new template
// (t3: the phase-1 file is gone) and its next turn is served by the new
// deployment's manifest (t4: the skill loads and shapes the reply).
export default defineEval({
  description:
    "Sandbox redeploy phase 3: a skill-adding redeploy rotates the session sandbox and serves the new skill.",
  tags: ["redeploy"],
  async test(t) {
    requireRedeployPhase(t, "read-rotated");
    const { rotateSessionId } = await loadRedeployState();

    const session = await t.target.attachSession(rotateSessionId);

    const probe = await session.send(
      `Run the bash command \`test -f ${REDEPLOY_FILE_PATH} && echo present || echo absent\` ` +
        "and reply with the command output verbatim.",
    );
    probe.expectOk();
    probe.calledTool("bash", { output: /absent/ });
    probe.messageIncludes("absent");

    const skillTurn = await session.send(
      "Please use the deploy note skill and follow its instructions exactly.",
    );
    skillTurn.expectOk();
    skillTurn.loadedSkill(REDEPLOY_SKILL_NAME);
    skillTurn.messageIncludes(REDEPLOY_SKILL_TOKEN);
  },
});
