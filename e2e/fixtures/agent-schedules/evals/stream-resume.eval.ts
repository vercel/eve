import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

/**
 * Proof that `GET /eve/v1/session/:id/stream?startIndex=N` replays missed
 * events from durable storage when a reader reconnects mid-conversation:
 * drives a multi-step turn to completion, reattaches at a non-zero
 * `startIndex`, and asserts the replayed tail matches the full event log
 * sliced at that index. Both reads go through the eval target's authenticated
 * client, so the eval works against local and deployed targets alike.
 */
export default defineEval({
  description: "Session stream resume: ?startIndex replays missed events after a reconnect.",

  async test(t) {
    // Drive a multi-step turn so the event log is long enough to split.
    const turn = await t.send(
      [
        "Follow these steps exactly:",
        "1. Call the `lookup-step-a` tool with topic 'demo'.",
        "2. Take the `stepKey` it returns and call the `lookup-step-b` tool with that exact stepKey.",
        "3. Reply with the final `value` from `lookup-step-b` verbatim, with no extra commentary.",
      ].join("\n"),
    );

    const sessionId = turn.sessionId;

    const fullLog = turn.events;
    // Split at the first actions.requested so the replay tail spans tool
    // execution and the final assistant message.
    const cutoff = fullLog.findIndex((event) => event.type === "actions.requested");
    await t.require(
      cutoff,
      satisfies((value: number) => value > 0, "actions.requested appears after index 0"),
    );
    t.log(`full turn produced ${fullLog.length} events; replaying from index ${cutoff}`);

    // Reconnect at startIndex=cutoff through the authenticated client and
    // assert the replayed tail matches the full log from that index on.
    const resumed = await t.target.attachSession(sessionId, { startIndex: cutoff });
    const replayed = resumed.events;
    const expected = fullLog.slice(cutoff);

    t.check(
      replayed.map((event) => event.type),
      equals(expected.map((event) => event.type)),
    );
    t.log(`replayed ${replayed.length} events from index ${cutoff}; matches the durable log`);
    t.succeeded();
  },
});
