import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  GRANT_TOKEN,
  answer,
  isOwn,
  paused,
  reportsIn,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * The parent checks Lisbon itself in the step that starts two children, and all three need the
 * same grant. The parent's own sign-in pauses the step before the children start, so its card is
 * the only one. Accepting it runs the parent's call, and the children then find the grant it
 * stored at the provider and run without a card.
 */
export default defineEval({
  description: "Accepting the parent's own card lets the children use its grant.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: "first" });
    await reader.readUntil(paused);
    const cards = signIns(reader.events);
    t.check(cards.map(isOwn), equals([true]));

    await answer(t, cards[0]!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(1));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(errors, equals([]));
    t.check(
      calls.map(({ city, token }) => `${city} ${token}`).sort(),
      equals([`Lisbon 0 ${GRANT_TOKEN}`, `Lisbon 1 ${GRANT_TOKEN}`, `Lisbon parent ${CODE_TOKEN}`]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
