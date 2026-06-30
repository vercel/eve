import { defineEval } from "eve/evals";

import { DEPTH_PROBER_TOOL_HIDDEN_MARKER } from "../agent/subagents/depth-prober/agent.js";

const DEPTH_RESULT_MARKER = "SUBAGENT_DEPTH_LIMIT_E2E_OK";

export default defineEval({
  description:
    "Subagent limits e2e: a child subagent does not see nested subagent tools after maxDepth is reached.",
  tags: ["subagents", "limits", "depth"],

  async test(t) {
    await t.send("depth guardrail e2e: ask the depth-prober subagent to attempt one nested call.");

    t.succeeded();
    t.calledSubagent("depth-prober", {
      output: new RegExp(DEPTH_PROBER_TOOL_HIDDEN_MARKER),
      count: 1,
    });
    t.messageIncludes(DEPTH_RESULT_MARKER);
    t.messageIncludes(DEPTH_PROBER_TOOL_HIDDEN_MARKER);
  },
});
