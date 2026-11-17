import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

/** The id the scripted parent gives its `eve__execute` call; its agent call takes `<id>/1`. */
const PROGRAM_CALL = "question-sleeper";
const ANSWER = "PROGRAM-QUESTION-MARKER";

export default defineEval({
  description:
    "A question from an agent that an eve__execute program called reaches the parent session, and its answer resumes the program in the same turn.",
  timeoutMs: 120_000,
  async test(t) {
    const parked = await t.send(
      "Alice needs a marker that only the sleeper can confirm with her. Please ask the sleeper agent from one program with the message PROGRAM-CHILD-QUESTION, and return what it replies.",
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
    // The program's call stays open while the sleeper waits for Alice.
    parked.calledTool(EXECUTE_TOOL, { count: 1, status: "pending" });

    const resumed = await session.respond([{ interactionId: request.interactionId, text: ANSWER }]);
    resumed.expectOk();
    // The answer's delivery can finish while the program still waits for the sleeper's reply.
    if (
      !session.events.some((event) => event.type === "turn.settled" && event.data.turnId === turnId)
    ) {
      await session.nextTurn({ startIndex: (session.events.at(-1)?.meta.position.line ?? -1) + 1 });
    }

    // The program held the turn the whole time: the turn that asked is the one that completes.
    session.event("turn.settled", { count: 1, data: { turnId, outcome: "completed" } });
    t.check(session.pendingInteractions.length, equals(0)).label("no pending child question");
    t.succeeded();
    t.calledTool(EXECUTE_TOOL, {
      count: 1,
      output: { result: new RegExp(`CHILD_ANSWER=.*${ANSWER}`, "su") },
    });
    t.calledTool("sleeper", { count: 1, output: new RegExp(`CHILD_ANSWER=.*${ANSWER}`, "su") });
    t.event("child.opened", {
      count: 1,
      data: { name: "sleeper", owner: { callId: `${PROGRAM_CALL}/1` } },
    });
    t.notEvent("task.started");
    t.messageIncludes("CHILD_ANSWER=");
    t.messageIncludes(ANSWER);
    t.noFailedCalls();
  },
});
