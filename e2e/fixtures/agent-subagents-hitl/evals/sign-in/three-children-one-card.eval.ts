import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  GRANT_TOKEN,
  answer,
  idsOf,
  turnOutcomes,
  reportsIn,
  shownCards,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children ask for the same weather grant at once. The parent shows one card, and the
 * other two sign-ins wait on it. One acceptance settles all three, and every child's call runs:
 * the answered one on the token its exchange minted, the others on the stored grant.
 */
export default defineEval({
  description: "Three children that need one grant share one card, and one acceptance runs all.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3 });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card, ...waiting] = signIns(reader.events);
    t.check(idsOf(shownCards(reader.events)), equals([card!.data.interactionId]));
    t.check(
      waiting.map((row) => row.data.request.signIn?.waitsOn),
      equals([card!.data.interactionId, card!.data.interactionId]),
    );

    await answer(t, card!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(3));
    t.check(shownCards(events).length, equals(1));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted", "accepted"]),
    );
    const { calls } = reportsIn(events);
    t.check(calls.map(({ city }) => city).sort(), equals(["Lisbon 0", "Lisbon 1", "Lisbon 2"]));
    t.check(calls.map(({ token }) => token).sort(), equals([CODE_TOKEN, GRANT_TOKEN, GRANT_TOKEN]));
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
