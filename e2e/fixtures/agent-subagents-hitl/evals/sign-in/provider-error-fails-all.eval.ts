import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  answer,
  reportsIn,
  signInSettlements,
  signIns,
  startFanIn,
  turnOutcomes,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card, and the provider redirects back with `error=server_error`. The
 * shown card and the two sign-ins that waited on it fail, no call runs, and no other card opens.
 */
export default defineEval({
  description: "A provider error on the shown card fails every sign-in waiting on it.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3 });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card] = signIns(reader.events);

    await answer(t, card!, { error: "server_error" });
    await reader.readUntil(turnSettled);

    const events = reader.events;
    t.check(signIns(events).length, equals(3));
    t.check(
      signInSettlements(events).map((settled) => settled.data.outcome),
      equals(["failed", "failed", "failed"]),
    );
    const { calls, errors } = reportsIn(events);
    t.check(calls, equals([]));
    t.check(errors.length, equals(3));
    t.check(turnOutcomes(events), equals(["completed"]));
  },
});
