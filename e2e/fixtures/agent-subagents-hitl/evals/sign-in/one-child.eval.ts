import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  answer,
  turnOutcomes,
  reportsIn,
  shownCards,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * One child needs the weather sign-in. The parent shows its one card, the person accepts it,
 * and the child's call runs on the token that sign-in minted.
 */
export default defineEval({
  description: "A single child's sign-in shows one card, and accepting it runs the child's call.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 120_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 1 });
    await reader.readUntil((events) => signIns(events).length === 1);
    const [card] = signIns(reader.events);
    t.check(card!.data.request.signIn?.waitsOn, equals(undefined));

    await answer(t, card!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(1));
    t.check(shownCards(events).length, equals(1));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["accepted"]),
    );
    t.check(
      reportsIn(events).calls.map(({ city, token }) => ({ city, token })),
      equals([{ city: "Lisbon 0", token: CODE_TOKEN }]),
    );
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
