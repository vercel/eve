import { defineEval } from "eve/evals";

export default defineEval({
  description: "A generated workflow program proxies a child question through the existing owner.",
  timeoutMs: 120_000,
  async test(t) {
    const { session } = await t.send(
      "Use the workflow tool exactly once to call the sleeper subagent with the message GENERATED-PROGRAM-CHILD-HITL. Return the child result.",
    );
    const request = session.requireInteraction({
      prompt: "What marker should the child return?",
      toolName: "ask_question",
    });
    if (request.request.kind !== "question")
      throw new Error("Child input request is not a question.");

    const answered = await session.respond([
      { interactionId: request.interactionId, text: "GENERATED-HITL-MARKER" },
    ]);
    answered.expectOk();
    const resumed = await session.nextTurn();
    resumed.expectOk();

    t.succeeded();
    t.calledTool("workflow", { count: 1 });
    // The workflow tool runs as a task: its result settles the task, not the call.
    t.event("call.settled", {
      count: 1,
      data: { output: /CHILD_HITL_RESULT=.*GENERATED-HITL-MARKER/su, outcome: "completed" },
    });
    t.event("child.opened", { count: 1, data: { name: "sleeper" } });
    t.messageIncludes("CHILD_HITL_RESULT=");
    t.messageIncludes("GENERATED-HITL-MARKER");
    t.noFailedCalls();
  },
});
