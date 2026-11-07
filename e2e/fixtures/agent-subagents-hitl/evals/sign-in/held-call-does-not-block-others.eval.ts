import { defineEval } from "eve/evals";
import { equals } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  answer,
  turnOutcomes,
  logReports,
  reportsIn,
  signIns,
  signInSettlements,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card. The answered child's call holds after its sign-in completes
 * until the other two calls have finished their protected work. The others hear the answer as that
 * sign-in completes, not when its call returns, so they finish while it holds. If they waited on its call, it would
 * fail after its hold limit.
 */
export default defineEval({
  description: "The others' calls return while the answered child's call still holds.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3, hold: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card] = signIns(reader.events);

    await answer(t, card!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const { calls, errors } = reportsIn(reader.events);

    logReports(t, reader.events);
    for (const settled of signInSettlements(reader.events))
      t.log(`sign-in ${settled.data.interactionId} ${settled.data.outcome} at ${settled.meta.at}`);
    for (const call of calls)
      t.log(`call ${call.city} token=${call.token} at ${new Date(call.at).toISOString()}`);
    t.check(errors, equals([]));
    t.check(calls.length, equals(3));
    // The held call's barrier passing is the proof: it returns only once the other two calls
    // finished their protected work, so they did that while it held.
    t.check(calls.filter((call) => call.token === CODE_TOKEN).length, equals(1));
    t.check(turnOutcomes(reader.events), equals(["completed"]));
  },
});
