import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  answer,
  logReports,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * Three children ask at once for sign-ins that name no Connect grant. Each keeps its own card,
 * accepting one completes only that child's sign-in, and the rest run once their own are accepted.
 */
export default defineEval({
  description: "Sign-ins with no grant keep their own cards.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3, noGrant: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    const cards = shownCards(reader.events);
    t.check(cards.length, equals(3));

    await answer(t, cards[0]!, { code: ACCEPT_CODE });
    await reader.readUntil((events) => signInSettlements(events).length >= 1);
    t.check(signInSettlements(reader.events).length, equals(1));
    for (const card of cards.slice(1)) await answer(t, card, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted", "accepted"]),
    );
    const { calls, errors } = reportsIn(events);
    logReports(t, events);
    t.check(errors, equals([]));
    t.check(
      calls.map(({ token }) => token),
      equals([CODE_TOKEN, CODE_TOKEN, CODE_TOKEN]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
