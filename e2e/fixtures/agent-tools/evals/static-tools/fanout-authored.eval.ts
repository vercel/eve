import { defineEval } from "eve/evals";

import {
  authoredFanoutExecutionsOverlap,
  FANOUT_SIZE,
  fanoutRequestsPrecedeFirstResult,
  fanoutRequestsUseExpectedLabels,
} from "./fanout.js";

const TOOL_NAME = "streamed-action";
const LABELS = [
  "fanout-authored-01",
  "fanout-authored-02",
  "fanout-authored-03",
  "fanout-authored-04",
  "fanout-authored-05",
  "fanout-authored-06",
  "fanout-authored-07",
  "fanout-authored-08",
  "fanout-authored-09",
  "fanout-authored-10",
] as const;

export default defineEval({
  description: "Static tools smoke: ten authored tool calls begin concurrently.",
  async test(t) {
    const turn = await t.send(
      [
        `Call the \`${TOOL_NAME}\` tool exactly ${FANOUT_SIZE} separate times in one tool-use step.`,
        `Use each label exactly once: ${LABELS.map((label) => `"${label}"`).join(", ")}.`,
        "Start every call before waiting for any result. Do not use any other tool.",
        "After every call returns, reply with exactly: authored fanout complete",
      ].join("\n"),
    );
    turn.expectOk();

    t.succeeded();
    t.calledTool(TOOL_NAME, { count: FANOUT_SIZE });
    t.noFailedActions();
    turn.eventsSatisfy("ten authored requests precede the first authored result", (events) =>
      fanoutRequestsPrecedeFirstResult({ events, toolName: TOOL_NAME }),
    );
    turn.eventsSatisfy("ten authored requests use their distinct labels", (events) =>
      fanoutRequestsUseExpectedLabels({ events, labels: LABELS, toolName: TOOL_NAME }),
    );
    turn.eventsSatisfy("ten authored executions overlap", (events) =>
      authoredFanoutExecutionsOverlap({ events, toolName: TOOL_NAME }),
    );
  },
});
