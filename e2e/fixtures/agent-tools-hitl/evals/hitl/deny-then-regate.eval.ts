import { defineEval } from "eve/evals";

import { guardedEchoResults } from "./shared.js";

/**
 * HITL flow: `once()` approval semantics — a denial does not grant, so the
 * follow-up guarded call re-parks. Parking is server-side, so every
 * park/resume here is deterministic.
 */
export default defineEval({
  description: "HITL smoke: a denied once() call does not execute and re-gates the next call.",
  async test(t) {
    await t.send('Call the guarded-echo tool with note "denied-call".');
    t.expectInputRequests({ toolName: "guarded-echo" });

    const denied = await t.respondAll("deny");
    denied.expectOk();
    if (guardedEchoResults(t.events).length > 0) {
      throw new Error("Denied guarded-echo call must not execute.");
    }
    // The denial returns to the model as context; real models paraphrase it,
    // so judge the acknowledgment instead of matching literal wording.
    t.judge.autoevals
      .closedQA(
        "The reply acknowledges that the guarded-echo tool call was denied and did not run.",
        {
          on: denied.message,
        },
      )
      .atLeast(0.5);

    await t.send('Call the guarded-echo tool once more with note "retry-call".');
    // Denial does not grant: the follow-up call must re-park.
    t.expectInputRequests({ toolName: "guarded-echo" });

    t.didNotFail();
    t.waiting();
  },
});
