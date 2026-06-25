import { defineEval } from "eve/evals";

import { BOOTSTRAP_MARKER_PATH, BOOTSTRAP_MARKER_TOKEN } from "./shared.js";

// The prompt directs the model to run the backticked `bash` command; a
// non-error result containing the marker token proves the bootstrap-written
// file is visible inside the sandbox.
export default defineEval({
  description: "Sandbox smoke: `defineSandbox({ bootstrap })` runs before the first bash call.",
  async test(t) {
    await t.send(
      `Run the bash command \`cat ${BOOTSTRAP_MARKER_PATH}\` and reply with the file contents verbatim.`,
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(BOOTSTRAP_MARKER_TOKEN),
    });
  },
});
