import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
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
 * Two children's sign-ins and the parent's own are open on one card. Declining the parent's own
 * declines all three, no call runs, no other card opens, and the parent still completes.
 */
export default defineEval({
  description: "Declining the parent's own card declines the children's sign-ins too.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    t.check(shownCards(reader.events).length, equals(1));
    const own = signIns(reader.events).find(isOwn);

    await answer(t, own!, { error: "access_denied" });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(3));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["declined", "declined", "declined"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(calls, equals([]));
    t.check(errors.length, equals(3));
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
