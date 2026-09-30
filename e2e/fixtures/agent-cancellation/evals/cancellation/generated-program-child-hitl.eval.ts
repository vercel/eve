import { defineEval } from "eve/evals";

export default defineEval({
  description: "A generated workflow program proxies a child question through the existing owner.",
  timeoutMs: 120_000,
  async test(t) {
    const { session } = await t.send(
      "Use the workflow tool exactly once to call the sleeper subagent with the message GENERATED-PROGRAM-CHILD-HITL. Return the child result.",
    );
    const request = session.requireInputRequest({
      prompt: "What marker should the child return?",
      toolName: "ask_question",
    });
    if (request.kind !== "question") throw new Error("Child input request is not a question.");

    const resumed = await session.respond([
      { requestId: request.requestId, text: "GENERATED-HITL-MARKER" },
    ]);
    resumed.expectOk();

    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    // The workflow tool runs as a task: its result settles the task, not the call.
    t.event("task.settled", {
      count: 1,
      data: { output: /CHILD_HITL_RESULT=.*GENERATED-HITL-MARKER/su, status: "completed" },
    });
    t.event("agent.started", { count: 1, data: { name: "sleeper" } });
    t.messageIncludes("CHILD_HITL_RESULT=");
    t.messageIncludes("GENERATED-HITL-MARKER");
    t.noFailedActions();
  },
});
