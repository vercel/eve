import { defineEval } from "eve/evals";

import {
  BOOTSTRAP_MARKER_PATH,
  BOOTSTRAP_MARKER_TOKEN,
  SANDBOX_CLI_NAME,
  SANDBOX_CLI_TOKEN,
  SESSION_MARKER_PATH,
  SESSION_MARKER_TOKEN,
  WORKSPACE_SEED_PATH,
  WORKSPACE_SEED_TOKEN,
} from "./shared";

// The first command observes bootstrap, onSession, and workspace seeding,
// then invokes the bootstrap-installed Python CLI by name through PATH.
export default defineEval({
  tags: ["real-model"],
  description:
    "The first bash command sees bootstrap, per-session setup, workspace seeds, and the installed CLI.",
  async test(t) {
    const command =
      `cat ${BOOTSTRAP_MARKER_PATH} ${SESSION_MARKER_PATH} ${WORKSPACE_SEED_PATH}` +
      ` && ${SANDBOX_CLI_NAME} sandbox`;
    const turn = await t.send(
      "Alice is verifying the initial sandbox setup for Bob. " +
        `Run the bash command \`${command}\` exactly once, then reply with its combined output verbatim.`,
    );
    turn.expectOk();
    turn.calledTool("bash", { count: 1 });
    turn.calledTool("bash", {
      output: new RegExp(BOOTSTRAP_MARKER_TOKEN),
    });
    turn.calledTool("bash", {
      output: new RegExp(`${SESSION_MARKER_TOKEN}[\\s\\S]*${WORKSPACE_SEED_TOKEN}`),
    });
    turn.calledTool("bash", {
      output: new RegExp(`${SANDBOX_CLI_TOKEN}:sandbox`),
    });
    turn.messageIncludes(SESSION_MARKER_TOKEN);
    turn.messageIncludes(WORKSPACE_SEED_TOKEN);
    turn.messageIncludes(`${SANDBOX_CLI_TOKEN}:sandbox`);
    t.succeeded();
  },
});
