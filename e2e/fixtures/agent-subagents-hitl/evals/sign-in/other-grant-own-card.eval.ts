import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
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
 * Two children ask at once for sign-ins to two different connectors. Each gets its own card,
 * and accepting one runs only that child's call; the other runs once its own card is accepted.
 */
export default defineEval({
  description: "Sign-ins for different grants keep their own cards.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 2, otherFrom: 1 });
    await reader.readUntil((events) => signIns(events).length === 2);
    const cards = shownCards(reader.events);
    t.check(cards.length, equals(2));

    await answer(t, cards[0]!, { code: ACCEPT_CODE });
    await reader.readUntil((events) => signInSettlements(events).length >= 1);
    t.check(signInSettlements(reader.events).length, equals(1));
    await answer(t, cards[1]!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(errors, equals([]));
    t.check(
      calls.map(({ token }) => token),
      equals([CODE_TOKEN, CODE_TOKEN]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
