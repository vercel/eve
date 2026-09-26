import { defineEval } from "eve/evals";

const MEMORABLE_FACT = "Alice named the tide station notebook Harbor Lumen 4482.";

/**
 * Cross-turn continuation of a remote child over a real HTTP hop: turn one
 * delegates a fact to `remote-loopback`, which parks once it replies; turn two
 * re-messages the same remote child via its taskId. The fact can only come
 * back if the continuation reached the same remote session.
 */
export default defineEval({
  description:
    "A parked remote child re-messaged in a later parent turn still recalls a fact from its first turn.",
  tags: ["real-model"],
  async test(t) {
    const first = await t.send(
      [
        "Use the remote-loopback agent with this message:",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );
    first.expectOk();

    const second = await first.session.send(
      [
        "Message that same remote-loopback agent again: call it again with the taskId of the task you started earlier",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );
    second.expectOk();
    second.messageIncludes(MEMORABLE_FACT);

    t.succeeded();
    t.eventsSatisfy("both turns continue one remote child session", (events) => {
      const calls = events.flatMap((event) =>
        event.type === "task.started" && event.data.name === "remote-loopback" ? [event.data] : [],
      );
      return (
        calls.length >= 2 &&
        new Set(calls.map((call) => call.taskId)).size === 1 &&
        new Set(calls.map((call) => call.turnId)).size >= 2
      );
    });
    t.event("agent.started", { data: { name: "remote-loopback" }, count: 1 });
    t.noFailedActions();
  },
});
