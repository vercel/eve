import type { SessionStreamEvent } from "eve/client";
import { defineEval } from "eve/evals";

const SUBAGENT_TOKEN = "SUBAGENT_TOKEN=echo-marker-9F2X";
const DOUBLE_SUBAGENT_TOKEN = new RegExp(`${SUBAGENT_TOKEN}.*${SUBAGENT_TOKEN}`, "s");

function isFanOutProgram(input: unknown): boolean {
  if (typeof input !== "object" || input === null) return false;
  const code = (input as { readonly code?: unknown }).code;
  return (
    typeof code === "string" &&
    code.includes("Promise.all") &&
    code.includes("echo-marker") &&
    code.includes("workflow alpha") &&
    code.includes("workflow beta")
  );
}

/** A model writes one background program that asks two agents at once and combines their replies. */
export default defineEval({
  tags: ["real-model"],
  description:
    "A model-written workflow program fans out to two echo-marker sessions at once in the background and returns both replies as its task's result.",
  async test(t) {
    const session = await t.session();
    const parent = await session.start(
      [
        "Alice is confirming that two echo-marker assistants can answer at the same time while a job runs in the background.",
        "Please call the workflow tool exactly once, with a program that sends the messages 'workflow alpha' and 'workflow beta' to the echo-marker agent through `tools` calls inside Promise.all and returns the two replies as an array.",
        "Ask echo-marker only from that workflow program, not directly and not from eve__execute.",
        "Wait for the task, then reply with the array the program returned, which is the `result` field of the task's result, as JSON.",
      ].join(" "),
    );
    const firstStarted = await parent.waitForEvent("child.opened", {
      data: { name: "echo-marker" },
    });
    const firstChild = t.target.attach(firstStarted.data.sessionId).watch().result();
    const secondStarted = await parent.waitForEvent("child.opened", {
      data: {
        name: "echo-marker",
        sessionId: (sessionId) => sessionId !== firstStarted.data.sessionId,
      },
    });
    const secondChild = t.target.attach(secondStarted.data.sessionId).watch().result();
    const [turn, firstChildTurn, secondChildTurn] = await Promise.all([
      parent.result(),
      firstChild,
      secondChild,
    ]);
    // Each child's own turn start, not the parent's `agent.started`: the parent
    // publishes that at its next step boundary, which can be after a quick child
    // finished.
    const childStartedAt = (events: readonly SessionStreamEvent[]) =>
      (events.find((event) => event.type === "turn.started") ?? events[0])!.meta.at;
    const latestCallAt = [
      childStartedAt(firstChildTurn.events),
      childStartedAt(secondChildTurn.events),
    ]
      .sort()
      .at(-1)!;
    const completesAfterBothStart = (events: readonly SessionStreamEvent[]) =>
      events.some(
        (event) =>
          event.type === "turn.settled" &&
          event.data.outcome === "completed" &&
          event.meta.at > latestCallAt,
      );

    t.succeeded();
    t.calledTool("workflow", { input: isFanOutProgram, count: 1 });
    // The program runs as a task, and both child sessions belong to the call that started it.
    const workflowCall = turn.requireToolCall("workflow");
    turn.event("task.started", { count: 1, data: { name: "workflow" } });
    turn.event("child.opened", {
      count: 2,
      data: { name: "echo-marker", owner: { callId: workflowCall.callId } },
    });
    firstChildTurn.eventsSatisfy(
      "first child does not complete before both children start",
      completesAfterBothStart,
    );
    secondChildTurn.eventsSatisfy(
      "second child does not complete before both children start",
      completesAfterBothStart,
    );
    firstChildTurn.messageIncludes(SUBAGENT_TOKEN);
    secondChildTurn.messageIncludes(SUBAGENT_TOKEN);
    t.messageIncludes(DOUBLE_SUBAGENT_TOKEN);
    t.noFailedCalls();
  },
});
