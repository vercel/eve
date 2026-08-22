import { defineEval } from "eve/evals";

const MARKER = "followup-dedup-H4K8";
const TOOL_NAME = "gate";
const FOLLOW_UP_QUESTIONS = [
  "What is the current status of my request?",
  "Has the requested action executed yet?",
  "What are you waiting for before continuing?",
  "Can you summarize what remains blocked?",
  "What will happen after I approve the request?",
] as const;

/** Regression coverage for https://github.com/vercel/eve/issues/2217. */
export default defineEval({
  tags: ["real-model"],
  description: "One pending approval stays singular across many follow-up questions.",
  async test(t) {
    const parked = await t.send(`Call the ${TOOL_NAME} tool exactly once with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    const approval = t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    for (const question of FOLLOW_UP_QUESTIONS) {
      const followup = await t.send(question);

      followup.expectOk();
      followup.usedNoTools();
      followup.notEvent("input.requested");
      followup.event("session.waiting", { count: 1 });
    }

    const approved = await t.respond([
      {
        optionId: "approve",
        requestId: approval.requestId,
      },
    ]);

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
    // The original request completes once; each scoped follow-up above proves
    // that no intervening turn created another tool call or approval.
    t.calledTool(TOOL_NAME, { count: 1 });
  },
});
