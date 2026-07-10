import { defineEval } from "eve/evals";

import {
  SESSION_MARKER_PATH,
  SESSION_MARKER_TOKEN,
  WORKSPACE_SEED_PATH,
  WORKSPACE_SEED_TOKEN,
} from "./shared";

// Two session-scoped setup surfaces in one bash call:
//   1. `onSession` wrote SESSION_MARKER_PATH into this live session.
//   2. `agent/sandbox/workspace/seed-data.txt` was mounted at WORKSPACE_SEED_PATH.
// A single `cat` of both files proving both tokens appear shows session-scoped
// setup and workspace seeding both landed on top of the shared template.
export default defineEval({
  description: "Sandbox: onSession marker and seeded workspace file are both present per session.",
  async test(t) {
    await t.send(
      `Run the bash command \`cat ${SESSION_MARKER_PATH} ${WORKSPACE_SEED_PATH}\` ` +
        "and reply with the combined file contents verbatim.",
    );

    t.succeeded();
    t.calledTool("bash", {
      output: new RegExp(`${SESSION_MARKER_TOKEN}[\\s\\S]*${WORKSPACE_SEED_TOKEN}`),
    });
    t.messageIncludes(SESSION_MARKER_TOKEN);
    t.messageIncludes(WORKSPACE_SEED_TOKEN);
  },
});
