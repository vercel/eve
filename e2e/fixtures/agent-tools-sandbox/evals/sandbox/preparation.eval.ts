import { defineEval } from "eve/evals";

import { PREPARATION_MARKER_PATH, PREPARATION_MARKER_TOKEN } from "./shared";

export default defineEval({
  tags: ["real-model"],
  description: "Sandbox preparation and Bash process substitution work in a fresh session.",
  async test(t) {
    await t.send(
      "Alice is checking her newly prepared workspace. Run the bash command " +
        `\`cmp <(printf workspace-ready) <(printf workspace-ready) && cat ${PREPARATION_MARKER_PATH}\` ` +
        "and reply with the file contents verbatim.",
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(PREPARATION_MARKER_TOKEN),
    });
  },
});
