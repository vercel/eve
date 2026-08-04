import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

/** `evt_` followed by a 26-character Crockford base32 ULID. */
const EVENT_ID = /^evt_[0-9ABCDEFGHJKMNPQRSTVWXYZ]{26}$/;

/**
 * Core session-route runtime behavior: durable stream event ids.
 *
 * Module tests cover the stamping seam in process; this is the only check
 * that the id survives the wire and a rewind.
 */
export default defineEval({
  description: "Session runtime smoke: stream event ids are stamped and stable across a rewind.",

  async test(t) {
    const turn = await t.send({
      message: 'Reply with exactly the text "id smoke" and nothing else.',
    });
    t.succeeded();

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
