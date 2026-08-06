import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "The tide station passphrase is HARBOR-LUMEN-4482.";

/**
 * Cross-turn continuation of a remote child over a real HTTP hop: turn one
 * delegates a fact to `remote-loopback` and lets it park; turn two
 * re-messages the same remote child via its agentId. The fact can only come
 * back if the continuation reached the same remote session.
 */
export default defineEval({
  description:
    "A parked remote child re-messaged in a later parent turn still recalls a fact from its first turn.",
  tags: ["real-model"],
  async test(t) {
    await t.send(
      [
        "Use the remote-loopback agent exactly once with this message (no outputSchema):",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );

    await t.send(
      [
        "Message that same remote-loopback agent again: call it with the agentId shown in the latest <agents> block",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );

    t.succeeded();
    t.calledSubagent("remote-loopback", { count: 2 });
    t.calledSubagent("remote-loopback", { output: new RegExp(MEMORABLE_FACT), count: 1 });
    t.eventsSatisfy("both turns continue one remote child session", (events) => {
      const childSessionIds = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "remote-loopback"
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
