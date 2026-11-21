import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  answer,
  isOwn,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * The two children ask for the weather grant only once the parent's own call asked for it, so the
 * parent's card is the one shown and the children's sign-ins wait on it. Accepting it completes
 * all three, and all three calls run.
 */
export default defineEval({
  description: "The children's sign-ins complete from the parent's card when it opens first.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: true, parentFirst: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    const cards = shownCards(reader.events);
    t.check(cards.map(isOwn), equals([true]));
    t.check(signIns(reader.events).map(isOwn), equals([true, false, false]));

    await answer(t, cards[0]!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted", "accepted"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(errors, equals([]));
    t.check(
      calls.map(({ city }) => city).sort(),
      equals(["Lisbon 0", "Lisbon 1", "Lisbon parent"]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
