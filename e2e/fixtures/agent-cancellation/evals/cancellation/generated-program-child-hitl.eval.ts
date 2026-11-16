import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

const ANSWER = "GENERATED-HITL-MARKER";
const CHILD_ANSWER = new RegExp(`CHILD_ANSWER=.*${ANSWER}`, "su");

export default defineEval({
  description:
    "A question from an agent that a workflow program called reaches the parent session, and its answer lets the background program finish its task.",
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send(
      "Alice needs a marker that only the sleeper can confirm with her. Please use the workflow tool once to call the sleeper subagent with the message PROGRAM-CHILD-QUESTION, and return what it replies.",
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

    const resumed = await session.respond([{ interactionId: request.interactionId, text: ANSWER }]);
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
    // The workflow tool runs as a task: its call returns a receipt, and the program's result
    // settles the task.
    t.event("task.started", { count: 1, data: { name: "workflow" } });
    t.event("call.settled", {
      count: 1,
      data: {
        outcome: "completed",
        output: { calls: { completed: 1 }, result: CHILD_ANSWER },
      },
    });
    t.event("child.opened", { count: 1, data: { name: "sleeper" } });
    t.messageIncludes("CHILD_ANSWER=");
    t.messageIncludes(ANSWER);
    t.noFailedCalls();
  },
});
