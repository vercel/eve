import { defineEval } from "eve/evals";

import { PREPARATION_MARKER_PATH, PREPARATION_MARKER_TOKEN } from "./shared";

// The prompt directs the model to run the backticked `bash` command; a
// non-error result containing the marker token proves the preparation-written
// file is visible inside the sandbox.
export default defineEval({
  tags: ["real-model"],
  description:
    "Sandbox smoke: `VercelSandbox.environment({ prepare })` runs before the first bash call.",
  async test(t) {
    await t.send(
      `Run the bash command \`cat ${PREPARATION_MARKER_PATH}\` and reply with the file contents verbatim.`,
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(PREPARATION_MARKER_TOKEN),
    });
  },
});
