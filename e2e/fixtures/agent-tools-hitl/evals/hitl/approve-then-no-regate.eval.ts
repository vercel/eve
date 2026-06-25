import { defineEval } from "eve/evals";

import { GUARDED_ECHO_TOKEN } from "./shared.js";

/**
 * HITL flow: `once()` approval semantics — a grant persists for the session,
 * so a second guarded call does not re-park. Parking is server-side, so every
 * park/resume here is deterministic.
 */
export default defineEval({
  description: "HITL smoke: an approved once() grant persists for the session.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "first-call".');
    t.expectInputRequests({ times: 1, toolName: "guarded-echo" });
    parked.calledTool("guarded-echo", { status: "pending", times: 1 });

    const approved = await t.respondAll("approve");
    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: {
          kind: "tool-result",
          toolName: "guarded-echo",
          output: new RegExp(GUARDED_ECHO_TOKEN),
        },
        status: "completed",
      },
      times: 1,
    });

    // A successful turn in an open session ends "waiting"; a re-park
    // would surface as pending input requests.
    const second = await t.send('Call the guarded-echo tool again with note "second-call".');
    second.completed();

    t.completed();
    t.calledTool("guarded-echo", {
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      times: 2,
    });
  },
});
