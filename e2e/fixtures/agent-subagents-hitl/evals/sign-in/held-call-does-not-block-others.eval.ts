import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  HOLD_LIMIT_MS,
  answer,
  turnOutcomes,
  reportsIn,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card. The answered child's call holds after its sign-in completes
 * until the other two calls have returned. The others hear the answer as that sign-in completes,
 * not when its call returns, so they return while it holds. If they waited on its call, it would
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
    t.check(errors, equals([]));
    t.check(calls.length, equals(3));
    const held = calls.filter((call) => call.token === CODE_TOKEN);
    const others = calls.filter((call) => call.token !== CODE_TOKEN);
    t.check(held.length, equals(1));
    t.check(
      others.map((call) => held[0]!.at - call.at),
      satisfies<number[]>(
        (leads) => leads.length === 2 && leads.every((lead) => lead > 0 && lead < HOLD_LIMIT_MS),
        "the others return before the held call, within its hold limit",
      ),
    );
    t.check(turnOutcomes(reader.events), equals(["completed"]));
  },
});
