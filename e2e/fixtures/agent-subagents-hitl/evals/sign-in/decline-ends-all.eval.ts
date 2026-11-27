import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  answer,
  turnOutcomes,
  reportsIn,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card, and the person declines it. All three sign-ins end declined,
 * no call runs, no other card opens for the rest of the turn, and the parent still completes.
 */
export default defineEval({
  description: "Declining the shared card declines every child's sign-in, with no other card.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3 });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card] = signIns(reader.events);

    await answer(t, card!, { error: "access_denied" });
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
