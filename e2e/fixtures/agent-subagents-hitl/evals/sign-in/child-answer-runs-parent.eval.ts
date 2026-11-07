import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  GRANT_TOKEN,
  answer,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * Two children share one card, and the parent checks Lisbon itself once both reported. Accepting
 * the child's card stores the grant at the provider, so the parent's own call runs without a
 * card of its own.
 */
export default defineEval({
  description: "A child's accepted card lets the parent's own call run without asking again.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: "after" });
    await reader.readUntil((events) => signIns(events).length === 2);
    const cards = shownCards(reader.events);
    t.check(cards.length, equals(1));

    await answer(t, cards[0]!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(2));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(errors, equals([]));
    t.check(
      calls.map(({ city }) => city).sort(),
      equals(["Lisbon 0", "Lisbon 1", "Lisbon parent"]),
    );
    t.check(calls.find(({ city }) => city === "Lisbon parent")?.token, equals(GRANT_TOKEN));
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
