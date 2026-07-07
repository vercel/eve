import { defineEval } from "eve/evals";

import {
  REDEPLOY_FILE_PATH,
  REDEPLOY_FILE_TOKEN,
  requireRedeployPhase,
  saveRedeployState,
} from "./shared.js";

const WRITE_PROMPT =
  `Run the bash command \`printf %s ${REDEPLOY_FILE_TOKEN} > ${REDEPLOY_FILE_PATH}\`. ` +
  "Reply with the single word: done.";

// Phase 1 (t0), against the first deployment: write a marker file into two
// fresh sessions' sandbox workspaces. Each session owns its own sandbox, so
// the later phases can prove divergent fates for the same starting state:
// the persist session's file survives an unchanged redeploy, the rotate
// session's file disappears when a skill-adding redeploy rotates its sandbox.
export default defineEval({
  description: "Sandbox redeploy phase 1: write a workspace file in two fresh sessions.",
  tags: ["redeploy"],
  async test(t) {
    requireRedeployPhase(t, "write");

    const persistTurn = await t.send(WRITE_PROMPT);
    persistTurn.expectOk();
    persistTurn.calledTool("bash");

    const rotateSession = t.newSession();
    const rotateTurn = await rotateSession.send(WRITE_PROMPT);
    rotateTurn.expectOk();
    rotateTurn.calledTool("bash");

    await saveRedeployState({
      persistSessionId: persistTurn.sessionId,
      rotateSessionId: rotateTurn.sessionId,
    });
    t.log(`persist session ${persistTurn.sessionId}, rotate session ${rotateTurn.sessionId}`);

    t.succeeded();
    t.noFailedActions();
  },
});
