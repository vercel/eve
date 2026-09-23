import { defineEval } from "eve/evals";

import { SANDBOX_CLI_NAME, SANDBOX_CLI_TOKEN } from "./shared";

// Environment preparation installed a custom Python CLI onto the PATH. Invoking it by
// name through the `bash` tool proves the prepared tooling is executable in
// later sessions and that the base image's Python runtime ran the script.
export default defineEval({
  tags: ["real-model"],
  description:
    "Sandbox: a custom CLI installed during preparation is on the PATH for later sessions.",
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
