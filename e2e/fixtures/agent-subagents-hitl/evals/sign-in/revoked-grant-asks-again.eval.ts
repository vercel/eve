import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  answer,
  turnOutcomes,
  reportsIn,
  shownCards,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * One child signs in and checks Lisbon, then revokes the grant at the provider. Its next call, for
 * Porto, finds the grant gone, so the parent shows a new card after the first one settled. Accepting it runs Porto, and the turn
 * finishes from that card.
 */
export default defineEval({
  description: "A call after the provider revoked the accepted grant shows a new card.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { again: true, children: 1 });
    await reader.readUntil((events) => signIns(events).length === 1);
    const [first] = signIns(reader.events);
    await answer(t, first!, { code: ACCEPT_CODE });

    // A turn that settles with no second card fails the check at once.
    await reader.readUntil((events) => signIns(events).length === 2 || turnSettled(events));
    t.check(signIns(reader.events).length, equals(2));
    const [, second] = signIns(reader.events);
    if (second === undefined) return;
    t.check(second.data.request.signIn?.waitsOn, equals(undefined));
    t.check(
      signInSettlements(reader.events).map((settled) => settled.data.interactionId),
      equals([first!.data.interactionId]),
    );
    await answer(t, second, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(shownCards(events).length, equals(2));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted"]),
    );
    t.check(
      reportsIn(events).calls.map(({ city, token }) => ({ city, token })),
      equals([
        { city: "Lisbon 0", token: CODE_TOKEN },
        { city: "Porto 0", token: CODE_TOKEN },
      ]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
