import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";
import type { SessionEventMeta } from "eve/client";

/** Whether each position follows the one before it: a later line, or a later index in its line. */
function ascending(positions: readonly SessionEventMeta["position"][]): boolean {
  return positions.every((position, index) => {
    const previous = positions[index - 1];
    if (previous === undefined) return true;
    return (
      position.line > previous.line ||
      (position.line === previous.line && position.index > previous.index)
    );
  });
}

/**
 * Core session-route runtime behavior: durable stream positions.
 *
 * Module tests cover line positions in process; this is the only check that
 * they survive the wire and a rewind.
 */
export default defineEval({
  description: "Session runtime smoke: stream positions are ordered and stable across a rewind.",

  async test(t) {
    const turn = await t.send('Reply with exactly the text "id smoke" and nothing else.');
    t.succeeded();

    const positions = turn.events.map((event) => event.meta.position);

    await t.require(
      positions,
      satisfies<readonly SessionEventMeta["position"][]>(
        (value) => value.length > 0 && ascending(value),
        "every event carries a position after the one before it",
      ),
    );

    // Re-reading the durable stream is not a new emission.
    const replay = await t.target.watchTurn(turn.sessionId, { startIndex: 0 }).result();

    await t.require(
      replay.events.map((event) => event.meta.position),
      equals(positions),
    );
  },
});
