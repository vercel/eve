import { defineEval } from "eve/evals";

import { TEMPLATE_PREPARE_MARKER_PATH, TEMPLATE_PREPARE_MARKER_TOKEN } from "./shared";

// The prompt directs the model to run the backticked `bash` command; a
// non-error result containing the marker token proves the template-prepared
// file is visible inside the sandbox.
export default defineEval({
  description: "Sandbox smoke: exported template preparation runs before the first bash call.",
  async test(t) {
    await t.send(
      `Run the bash command \`cat ${TEMPLATE_PREPARE_MARKER_PATH}\` and reply with the file contents verbatim.`,
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(TEMPLATE_PREPARE_MARKER_TOKEN),
    });
  },
});
