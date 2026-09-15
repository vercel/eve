import { defineEval } from "eve/evals";

export default defineEval({
  description: "A generated workflow program proxies a child question through the existing owner.",
  timeoutMs: 120_000,
  async test(t) {
    await t.send(
      "Use the workflow tool exactly once to call the sleeper subagent with the message GENERATED-PROGRAM-CHILD-HITL. Return the child result.",
    );
    const request = t.requireInputRequest({
      display: "text",
      toolName: "ask_question",
    });

    const resumed = await t.respond([
      { requestId: request.requestId, text: "GENERATED-HITL-MARKER" },
    ]);
    resumed.expectOk();

    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    t.calledSubagent("sleeper", { count: 1, status: "pending" });
    t.messageIncludes("GENERATED-HITL-MARKER");
    t.noFailedActions();
  },
});
