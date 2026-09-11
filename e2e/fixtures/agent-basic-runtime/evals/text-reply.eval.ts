import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

/** `evt_` followed by a 26-character Crockford base32 ULID. */
const EVENT_ID = /^evt_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * Smoke-test eval for `eve eval`.
 *
 * Sends a plain prompt and asserts the agent completes a turn without tools.
 * The prompt instructs a verbatim echo so the check stays stable across real
 * models without a judge. Rewinding the HTTP stream also verifies that
 * stamped event IDs survive both the wire and durable replay.
 */
export default defineEval({
  description: "A tool-free text reply carries durable event IDs that survive a stream rewind.",

  // Instructing an exact echo keeps the smoke test stable regardless of how
  // the model would otherwise phrase its reply.
  async test(t) {
    const turn = await t.send('Reply with exactly the text "smoke ping" and nothing else.');
    turn.expectOk();
    turn.messageIncludes("smoke ping");
    turn.usedNoTools();
    t.succeeded();
    t.messageIncludes("smoke ping");
    t.usedNoTools();

    const ids = turn.events.map((event) => event.meta.id);
    await t.require(
      ids,
      satisfies<readonly string[]>(
        (value) => value.length > 0 && value.every((id) => EVENT_ID.test(id)),
        "every event carries a well-formed evt_ id",
      ),
    );
    // Re-reading the durable stream is not a new emission.
    const replay = await t.target.watchTurn(turn.sessionId, { startIndex: 0 }).result();
    await t.require(
      replay.events.map((event) => event.meta.id),
      equals(ids),
    );
  },
});
