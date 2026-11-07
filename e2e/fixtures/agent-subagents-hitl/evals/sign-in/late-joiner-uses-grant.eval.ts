import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  GRANT_TOKEN,
  allSettled,
  answer,
  turnOutcomes,
  reportsIn,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * The first child's sign-in shows a card, and the person accepts it. The second child asks for
 * the same grant only after the first child reported. It reads the grant the provider stored for
 * the person, with no new card. Without that stored grant, it would open a second card.
 */
export default defineEval({
  description: "A child that asks after the card settled runs on the stored grant, with no card.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, late: true });
    await reader.readUntil((events) => signIns(events).length === 1);
    const [card] = signIns(reader.events);

    await answer(t, card!, { code: ACCEPT_CODE });
    // A second card fails the check at once rather than waiting for an answer that never comes.
    await reader.readUntil(
      (events) => signIns(events).length > 1 || (allSettled(events) && turnSettled(events)),
    );

    const events = reader.events;
    t.check(signIns(events).length, equals(1));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted"]),
    );
    t.check(
      reportsIn(events).calls.map(({ city, token }) => ({ city, token })),
      equals([
        { city: "Lisbon 0", token: CODE_TOKEN },
        { city: "Lisbon 1", token: GRANT_TOKEN },
      ]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
