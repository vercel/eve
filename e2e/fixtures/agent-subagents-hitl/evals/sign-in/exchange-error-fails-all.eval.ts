import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  EXCHANGE_FAILURE,
  FAILING_CODE,
  answer,
  turnOutcomes,
  reportsIn,
  signInSettlements,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card. The person accepts, but the token exchange for that code
 * fails. The shown card closes failed with the exchange's error, the two sign-ins that waited on
 * it fail too, no call runs, and no other card opens.
 */
export default defineEval({
  description: "A failed token exchange fails the shown card and every sign-in waiting on it.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3 });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card] = signIns(reader.events);

    await answer(t, card!, { code: FAILING_CODE });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(3));
    const settled = signInSettlements(events);
    t.check(
      settled.map((row) => row.data.outcome),
      equals(["failed", "failed", "failed"]),
    );
    t.check(
      settled.find((row) => row.data.interactionId === card!.data.interactionId)?.data.reason,
      equals(EXCHANGE_FAILURE),
    );
    t.check(reportsIn(events).calls, equals([]));
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
