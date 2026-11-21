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
 * Two children ask for the weather grant, and while their sign-ins are open the parent's own call
 * asks for it too. The person sees one card. Answering a child's sign-in completes the parent's
 * own and the other child's, and all three calls run.
 */
export default defineEval({
  description: "Answering a child's sign-in completes the parent's own open sign-in.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, parent: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    t.check(shownCards(reader.events).length, equals(1));
    const child = signIns(reader.events).find((card) => !isOwn(card));

    await answer(t, child!, { code: ACCEPT_CODE });
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
