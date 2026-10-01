import { defineEval } from "eve/evals";

import { CORRECTED_MEASUREMENT } from "../constants";

const TOOL = "remote-loopback";

export default defineEval({
  description: "Tool stubs: a remote agent's stub answers its messages in place of the agent.",
  // Stub sets are accepted only by the local server `eve eval` starts.
  tags: ["tool-stubs", "local-server"],
  timeoutMs: 120_000,
  async test(t) {
    const corrected = await t.send(
      `NOTEBOOK-CORRECT ${TOOL} Alice corrects the pier she asked about.`,
      { stubs: "notebook-remote" },
    );
    corrected.expectOk();
    corrected.messageIncludes(`NOTEBOOK-REPLY STUB ${CORRECTED_MEASUREMENT}`);
    corrected.event("agent.started", { count: 1, data: { name: TOOL } });
    t.noFailedActions();
  },
});
