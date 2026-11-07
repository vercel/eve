import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  answer,
  reportsIn,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * One child's sign-in is declined, and the child then makes a fresh call that needs the same
 * grant in the same turn. The decline stands: that call fails at once with no new card.
 */
export default defineEval({
  description: "A fresh call after a decline in the same turn fails with no new card.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 1, retry: true });
    await reader.readUntil((events) => signIns(events).length === 1);
    const [card] = signIns(reader.events);

    await answer(t, card!, { error: "access_denied" });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(1));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["declined"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(calls, equals([]));
    t.check(
      errors,
      satisfies<string[]>(
        (found) =>
          found.length === 2 &&
          /was declined/u.test(found[0]!) &&
          /won't be asked for again/u.test(found[1]!),
        "the first call fails as declined, and the second is refused without asking",
      ),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
