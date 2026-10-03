import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  approvalFor,
  asAlice,
  expectNotRun,
  expectResolved,
} from "../helpers.ts";

/**
 * The authorized change's policy must know who answered, so typing "approve"
 * never answers it. Alice's typed reply is an ordinary message: it steers
 * the turn past the approval, which is ignored and never runs.
 */
export default defineEval({
  description: "A typed reply never answers an approval guarded by a response policy.",
  tags: ["hitl", "human-input", "authorization", "text-reply"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(await session.send(SAY.authorized, asAlice), "authorized-change");

    const typed = (await session.send("approve", asAlice)).expectOk();
    typed.notEvent("approval.candidate");
    typed.notEvent("approval.settled");
    expectResolved(typed, request, "ignored");
    expectNotRun(typed, "authorized-change");
    typed.event("message.received", { count: 1, data: { message: "approve" } });
    typed.event("message.completed", { data: { message: "Authorized change: not run." } });
  },
});
