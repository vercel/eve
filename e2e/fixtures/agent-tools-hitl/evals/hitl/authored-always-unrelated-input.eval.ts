import { defineEval } from "eve/evals";

const MARKER = "authored-always-unrelated-input-P7M2";
const TOOL_NAME = "gate";

/** Regression reproduction for https://github.com/vercel/eve/issues/533. */
export default defineEval({
  description:
    "HITL repro (#533): unrelated input does not replay an unresolved authored tool call.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const unrelated = await t.send("Queue this unrelated note: ORBITAL-PINE-6C3R.");

    unrelated.expectOk();
    unrelated.notEvent("action.result", {
      data: { result: { toolName: TOOL_NAME } },
    });
    unrelated.notEvent("step.started");
    unrelated.event("session.waiting", { count: 1 });

    const approved = await t.respond({
      optionId: "approve",
      requestId: approval.requestId,
    });

    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          output: new RegExp(MARKER),
          toolName: TOOL_NAME,
        },
        status: "completed",
      },
      count: 1,
    });
    t.succeeded();
  },
});
