import { defineEval } from "eve/evals";

import { ECHO_LIMIT_TOKEN } from "../agent/subagents/echo-marker/agent.js";

const FANOUT_LIMIT_CODE = "EVE_SUBAGENT_STEP_LIMIT_EXCEEDED";
const FANOUT_RESULT_MARKER = "SUBAGENT_FANOUT_LIMIT_E2E_OK";

export default defineEval({
  description:
    "Subagent limits e2e: per-step fan-out overflow starts the first child and rejects the rest.",
  tags: ["subagents", "limits", "fanout"],

  async test(t) {
    await t.send("fanout guardrail e2e: request two echo-marker subagents in one model step.");

    t.succeeded();
    t.calledSubagent("echo-marker", {
      output: ECHO_LIMIT_TOKEN,
      count: 1,
    });
    t.event("action.result", {
      data: {
        result: {
          isError: true,
          kind: "subagent-result",
          output: {
            code: FANOUT_LIMIT_CODE,
            message: /This step requested 2 subagent calls, but eve allows 1/,
          },
          subagentName: "echo-marker",
        },
        status: "failed",
      },
      count: 1,
    });
    t.messageIncludes(FANOUT_RESULT_MARKER);
    t.messageIncludes(FANOUT_LIMIT_CODE);
  },
});
