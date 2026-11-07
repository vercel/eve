import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import {
  ACCEPT_CODE,
  CODE_TOKEN,
  HOLD_MS,
  answer,
  turnOutcomes,
  reportsIn,
  signIns,
  startFanIn,
  turnSettled,
} from "./helpers";

/**
 * Three children share one card. The answered child's call runs for five seconds after its
 * sign-in completes. The other two hear the answer as that sign-in completes, not when its call
 * returns, so their calls finish well before the held one.
 */
export default defineEval({
  description: "The others' calls finish while the answered child's long call still runs.",
  tags: ["hitl", "sign-in"],
  timeoutMs: 150_000,
  async test(t) {
    const reader = await startFanIn(t, { children: 3, hold: true });
    await reader.readUntil((events) => signIns(events).length === 3);
    const [card] = signIns(reader.events);

    await answer(t, card!, { code: ACCEPT_CODE });
    await reader.readUntil(turnSettled);

    const { calls } = reportsIn(reader.events);
    t.check(calls.length, equals(3));
    const held = calls.filter((call) => call.token === CODE_TOKEN);
    const others = calls.filter((call) => call.token !== CODE_TOKEN);
    t.check(held.length, equals(1));
    // Each other call returned at least half the hold before the held one did.
    t.check(
      others.map((call) => held[0]!.at - call.at),
      satisfies<number[]>(
        (leads) => leads.length === 2 && leads.every((lead) => lead >= HOLD_MS / 2),
        `the others return at least ${HOLD_MS / 2} ms before the held call`,
      ),
    );
    t.check(turnOutcomes(reader.events), equals(["completed"]));
  },
});
