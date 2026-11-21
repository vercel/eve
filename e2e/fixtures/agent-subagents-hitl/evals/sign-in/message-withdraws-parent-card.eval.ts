import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  allSettled,
  isOwn,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * The parent's own card is shown and the two children's sign-ins wait on it when the person sends
 * another message. The message withdraws the parent's card, the children's sign-ins fail with it,
 * so none is left open without a card, and no call runs.
 */
export default defineEval({
  description: "A message that withdraws the parent's card ends the sign-ins waiting on it.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: true, parentFirst: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    t.check(shownCards(reader.events).map(isOwn), equals([true]));

    await reader.send("Never mind the weather.");
    await reader.readUntil((events) => allSettled(events) && turnSettled(events));

    const events = reader.events;
    t.check(
      signInSettlements(events)
        .map((settled) => settled.data.outcome)
        .sort(),
      equals(["failed", "failed", "withdrawn"]),
    );
    t.check(reportsIn(events).calls, equals([]));
  },
});
