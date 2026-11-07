import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  allSettled,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * Two children wait on one shown card when the person cancels the turn. Cancelling withdraws the
 * card, the sign-in that waited on it is withdrawn with it, so none is left open, and no call runs.
 */
export default defineEval({
  description: "Cancelling the turn withdraws the shown card and the sign-in that waited on it.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2 });
    await reader.readUntil((events) => signIns(events).length === 2);
    t.check(shownCards(reader.events).length, equals(1));

    await reader.cancel();
    await reader.readUntil((events) => turnSettled(events) && allSettled(events));

    const events = reader.events;
    t.check(
      signInSettlements(events)
        .map((settled) => settled.data.outcome)
        .sort(),
      equals(["withdrawn", "withdrawn"]),
    );
    t.check(reportsIn(events).calls, equals([]));
    t.check(turnOutcomes(events), equals(["cancelled"]));
  },
});
