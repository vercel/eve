import { defineEval } from "eve/evals";

import {
  loadRedeployState,
  REDEPLOY_FILE_PATH,
  REDEPLOY_FILE_TOKEN,
  requireRedeployPhase,
} from "./shared.js";

// Phase 2 (t2), against the second deployment (same sources, new deployment):
// the session written in phase 1 reattaches to the same sandbox because
// session sandbox keys are deployment-independent — only the sandbox
// definition's version hash participates, and nothing changed. Reading the
// marker file back proves `/workspace` state survived the redeploy.
export default defineEval({
  description:
    "Sandbox redeploy phase 2: an unchanged redeploy keeps the session's sandbox workspace.",
  tags: ["redeploy"],
  async test(t) {
    requireRedeployPhase(t, "read-persist");
    const { persistSessionId } = await loadRedeployState();

    const session = await t.target.attachSession(persistSessionId);
    const turn = await session.send(
      `Run the bash command \`cat ${REDEPLOY_FILE_PATH}\` and reply with the file contents verbatim.`,
    );

    turn.expectOk();
    turn.calledTool("bash", { output: new RegExp(REDEPLOY_FILE_TOKEN) });
    turn.messageIncludes(REDEPLOY_FILE_TOKEN);
  },
});
