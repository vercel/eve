import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "The observatory locker code is ORBIT-CEDAR-7319.";

/**
 * Cross-turn continuation of a local child: turn one delegates a fact to the
 * built-in agent subagent, which answers and stays available; turn two
 * re-messages the same child via its agentId. The fact can only come back if
 * the child's session survived the parent turn boundary.
 */
export default defineEval({
  description:
    "A local child re-messaged in a later parent turn still recalls a fact from its first turn.",
  tags: ["real-model"],
  async test(t) {
    const started = await t.send(
      [
        "Call the built-in agent subagent with this message:",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );
    started.expectOk();
    started.calledSubagent("agent", { status: "completed", count: 1 });
    started.messageIncludes("delegated");

    const continued = await started.session.send(
      [
        "Message that same agent again: call the agent subagent with the agent id shown in the latest [Tasks] note",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );
    continued.expectOk();
    continued.calledSubagent("agent", {
      output: new RegExp(MEMORABLE_FACT),
      status: "completed",
      count: 1,
    });
    continued.messageIncludes(MEMORABLE_FACT);

    t.succeeded();
    t.eventsSatisfy("both turns continue one child session", (events) => {
      const calls = events.flatMap((event) =>
        event.type === "task.started" && event.data.name === "agent" ? [event.data] : [],
      );
      return (
        calls.length >= 2 &&
        new Set(calls.map((call) => call.taskId)).size === 1 &&
        new Set(calls.map((call) => call.child?.sessionId)).size === 1 &&
        new Set(calls.map((call) => call.turnId)).size >= 2
      );
    });
    t.noFailedActions();
  },
});
