import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

export default defineEval({
  description: "A generated workflow program proxies a child question through the existing owner.",
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send(
      "Use the workflow tool exactly once to call the sleeper subagent with the message GENERATED-PROGRAM-CHILD-HITL. Return the child result.",
    );
    const { session } = parked;
    const request = session.requireInteraction({
      prompt: "What marker should the child return?",
      toolName: "ask_question",
    });
    if (request.request.kind !== "question")
      throw new Error("Child input request is not a question.");
    const turnId = parked.events.flatMap((event) =>
      event.type === "turn.paused" &&
      event.data.awaiting.some((entry) => entry.interactionId === request.interactionId)
        ? [event.data.turnId]
        : [],
    )[0];
    if (turnId === undefined)
      throw new Error("The parent turn did not pause for the child question.");

    const resumed = await session.respond([
      { interactionId: request.interactionId, text: "GENERATED-HITL-MARKER" },
    ]);
    resumed.expectOk();
    // The child answer's delivery can finish while the parent workflow is still running.
    if (
      !session.events.some((event) => event.type === "turn.settled" && event.data.turnId === turnId)
    ) {
      await session.nextTurn({ startIndex: (session.events.at(-1)?.meta.position.line ?? -1) + 1 });
    }

    session.event("turn.settled", { count: 1, data: { turnId, outcome: "completed" } });
    t.check(session.pendingInteractions.length, equals(0)).label("no pending child question");
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
