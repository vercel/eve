import { defineEval } from "eve/evals";

import { SANDBOX_CLI_NAME, SANDBOX_CLI_TOKEN } from "./shared";

// `bootstrap` installed a custom Node CLI onto the PATH. Invoking it by name
// through the `bash` tool proves bootstrap-provisioned tooling is on the PATH
// and executable in later sessions.
export default defineEval({
  tags: ["real-model"],
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
