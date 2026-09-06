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
    const started = await t.send(
      [
        "Use the remote-loopback agent with this message (no outputSchema):",
        `"Remember this exact fact: ${MEMORABLE_FACT} Reply only with READY."`,
        "When it returns, reply with the single word: delegated.",
      ].join(" "),
    );
    started.expectOk();
    const firstCompletion = t.target.watchTurn(started.sessionId, {
      startIndex: requireStreamIndex(t),
    });
    const firstCompletedTurn = await firstCompletion.result();
    firstCompletedTurn.expectOk();

    const continued = await firstCompletion.session.send(
      [
        "Message that same remote-loopback agent again: call it with the agentId shown in the latest <agents> block",
        'and the message: "What exact fact did I ask you to remember? Reply with only the fact."',
        "Do not state the fact yourself.",
        "When it returns, reply with the agent's exact output and no other text.",
      ].join(" "),
    );
    continued.expectOk();
    const secondCompletedTurn = await t.target
      .watchTurn(started.sessionId, { startIndex: requireStreamIndex(firstCompletion.session) })
      .result();
    secondCompletedTurn.expectOk();
    secondCompletedTurn.messageIncludes(MEMORABLE_FACT);

    t.succeeded();
    t.eventsSatisfy("both turns continue one remote child session", (events) => {
      const calls = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "remote-loopback"
          ? [event.data]
          : [],
      );
      return (
        calls.length >= 2 &&
        new Set(calls.map((call) => call.childSessionId)).size === 1 &&
        new Set(calls.map((call) => call.turnId)).size >= 2
      );
    });
    t.noFailedActions();
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
  return streamIndex;
}
