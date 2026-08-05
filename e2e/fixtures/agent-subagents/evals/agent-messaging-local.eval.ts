import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "The observatory locker code is ORBIT-CEDAR-7319.";

/**
 * Cross-turn continuation of a local child: turn one delegates a fact to the
 * built-in agent subagent and lets it park; turn two re-messages the same
 * child via its agentId. The fact can only come back if the child's session
 * survived the parent turn boundary.
 */
export default defineEval({
  description:
    "A parked local child re-messaged in a later parent turn still recalls a fact from its first turn.",
  tags: ["real-model"],
  async test(t) {
    await t.send(
      [
        "Call the built-in agent subagent exactly once with this message:",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );

    await t.send(
      [
        "Message that same agent again: call the agent subagent with the agentId shown in the latest <agents> block",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );

    t.succeeded();
    t.calledSubagent("agent", { count: 2 });
    t.calledSubagent("agent", { output: new RegExp(MEMORABLE_FACT), count: 1 });
    t.eventsSatisfy("both turns continue one child session", (events) => {
      const childSessionIds = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "agent"
          ? [event.data.childSessionId]
          : [],
      );
      return (
        childSessionIds.length === 2 &&
        childSessionIds[0] !== undefined &&
        childSessionIds[0] === childSessionIds[1]
      );
    });
    t.messageIncludes(MEMORABLE_FACT);
    t.noFailedActions();
  },
});
