import { EXECUTE_TOOL } from "@eve-e2e/config/catalog-tools";
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
    code.includes("program alpha") &&
    code.includes("program beta")
  );
}

/** A model writes one program that asks two agents at once and combines their replies. */
export default defineEval({
  tags: ["real-model"],
  description:
    "A model-written eve__execute program fans out to two echo-marker sessions at once and returns both replies, with no task.",
  async test(t) {
    const session = await t.session();
    const parent = await session.start(
      [
        "Alice is confirming that two echo-marker assistants can answer at the same time.",
        "Please write one eve__execute program that sends the messages 'program alpha' and 'program beta' to the echo-marker agent together with Promise.all and returns the two replies as an array.",
        "Ask echo-marker only from that program.",
        "Then reply with the returned array as JSON.",
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
    // Each child's own turn start, not the parent's view of it: the parent publishes that at
    // its next step boundary, which can be after a quick child finished.
    const childStartedAt = (events: readonly SessionStreamEvent[]) =>
      (events.find((event) => event.type === "turn.started") ?? events[0])!.meta.at;
    const latestStartAt = [
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
          event.meta.at > latestStartAt,
      );

    t.succeeded();
    t.calledTool(EXECUTE_TOOL, { count: 1, input: isFanOutProgram });
    const program = turn.requireToolCall(EXECUTE_TOOL);
    turn.event("child.opened", { count: 2, data: { name: "echo-marker" } });
    turn.eventsSatisfy("each child session belongs to a call of the program", (events) =>
      events.every(
        (event) =>
          event.type !== "child.opened" ||
          ("callId" in event.data.owner &&
            event.data.owner.callId.startsWith(`${program.callId}/`)),
      ),
    );
    // The program awaits both replies, so neither call becomes a task the model waits on.
    turn.notEvent("task.started");
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
