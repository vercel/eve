import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  GRANT_TOKEN,
  answer,
  reportsIn,
  shownCards,
  signIns,
  signInSettlements,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Two people each run two children that need the same grant, at the same time. Each person gets
 * their own card. One person's acceptance runs only their own children: the other person's
 * sign-ins stay open until they answer their own card, and their calls run on their own grant.
 */
export default defineEval({
  description: "Two people's sign-ins for one grant never share a card or a grant.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const [alice, bob] = await Promise.all([
      startFanIn(t, { children: 2 }),
      startFanIn(t, { children: 2 }),
    ]);
    await Promise.all([
      alice.readUntil((events) => signIns(events).length === 2),
      bob.readUntil((events) => signIns(events).length === 2),
    ]);
    t.check(shownCards(alice.events).length, equals(1));
    t.check(shownCards(bob.events).length, equals(1));

    await answer(t, shownCards(alice.events)[0]!, { code: ACCEPT_CODE });
    await alice.readUntil(turnSettled);
    t.check(
      reportsIn(alice.events)
        .calls.map(({ token }) => token)
        .sort(),
      equals([CODE_TOKEN, GRANT_TOKEN]),
    );

    await answer(t, shownCards(bob.events)[0]!, { code: ACCEPT_CODE });
    await bob.readUntil(turnSettled);
    t.check(
      signInSettlements(bob.events).map((settled) => settled.data.outcome),
      equals(["accepted", "accepted"]),
    );
    t.check(
      reportsIn(bob.events)
        .calls.map(({ token }) => token)
        .sort(),
      equals([CODE_TOKEN, GRANT_TOKEN]),
    );
  },
});
