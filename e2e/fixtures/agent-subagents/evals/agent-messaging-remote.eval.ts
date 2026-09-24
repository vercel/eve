import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "Alice named the tide station notebook Harbor Lumen 4482.";

/**
 * Cross-turn continuation of a remote child over a real HTTP hop: turn one
 * delegates a fact to `remote-loopback`, which answers and stays available;
 * turn two re-messages the same remote child via its agentId. The fact can
 * only come back if the continuation reached the same remote session.
 */
export default defineEval({
  description:
    "A remote child re-messaged in a later parent turn still recalls a fact from its first turn.",
  tags: ["real-model"],
  async test(t) {
    const started = await t.send(
      [
        "Use the remote-loopback agent with this message (no outputSchema):",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );
    started.expectOk();
    started.calledSubagent("remote-loopback", { status: "completed", count: 1 });

    const continued = await started.session.send(
      [
        "Message that same remote-loopback agent again: call it with the agent id shown in the latest [Tasks] note",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );
    continued.expectOk();
    continued.calledSubagent("remote-loopback", {
      output: new RegExp(MEMORABLE_FACT),
      status: "completed",
      count: 1,
    });
    continued.messageIncludes(MEMORABLE_FACT);

    t.succeeded();
    t.eventsSatisfy("both turns continue one remote child session", (events) => {
      const calls = events.flatMap((event) =>
        event.type === "task.started" && event.data.name === "remote-loopback" ? [event.data] : [],
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
