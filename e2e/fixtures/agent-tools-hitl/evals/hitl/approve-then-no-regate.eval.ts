import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN, guardedEchoResults } from "./shared.js";

/**
 * HITL flow: `once()` approval semantics — a grant persists for the session,
 * so a second guarded call does not re-park. Parking is server-side, so every
 * park/resume here is deterministic.
 */
export default defineEval({
  description: "HITL smoke: an approved once() grant persists for the session.",
  async test(t) {
    await t.send('Call the guarded-echo tool with note "first-call".');
    t.expectInputRequests({ toolName: "guarded-echo" });

    const approved = await t.respondAll("approve");
    approved.expectOk();
    const [firstResult] = guardedEchoResults(t.events);
    if (firstResult === undefined || !firstResult.includes(GUARDED_ECHO_TOKEN)) {
      throw new Error("Approved guarded-echo call did not execute.");
    }

    // A successful turn in an open session ends "waiting"; a re-park
    // would surface as pending input requests.
    const second = await t.send('Call the guarded-echo tool again with note "second-call".');
    second.expectOk();
    if (second.inputRequests.length > 0) {
      throw new Error(
        `once() grant did not persist: turn re-parked on ${second.inputRequests.length} request(s).`,
      );
    }
    const results = guardedEchoResults(t.events);
    if (results.length !== 2 || !results[1]!.includes(GUARDED_ECHO_TOKEN)) {
      throw new Error(
        `Second guarded-echo call did not execute without re-approval (saw ${results.length} result(s)).`,
      );
    }

    t.didNotFail();
    t.completed();
  },
});
