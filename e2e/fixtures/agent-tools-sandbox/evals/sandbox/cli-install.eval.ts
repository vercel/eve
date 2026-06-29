import { defineEval } from "eve/evals";

import { SANDBOX_CLI_NAME, SANDBOX_CLI_TOKEN } from "./shared.js";

// `bootstrap` installed a custom Python CLI onto the PATH. Invoking it by
// name (no path) through the `bash` tool proves the bootstrap-provisioned
// tooling is both on the PATH and executable in later sessions, and that the
// base image's Python runtime ran the bootstrap-authored script.
export default defineEval({
  description: "Sandbox: a custom CLI installed in `bootstrap` is on the PATH for later sessions.",
  async test(t) {
    await t.send(
      `Run the bash command \`${SANDBOX_CLI_NAME} sandbox\` and reply with its output verbatim.`,
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(`${SANDBOX_CLI_TOKEN}:sandbox`),
    });
    t.messageIncludes(`${SANDBOX_CLI_TOKEN}:sandbox`);
  },
});
