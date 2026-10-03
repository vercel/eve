import { defineEval } from "eve/evals";

import {
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asReleaseManager,
  expectHeld,
} from "../helpers.ts";

/**
 * One step asks for change A and an authorized change. Alice types "approve":
 * that answers A, but never the authorized change, whose response policy must
 * know who answered. The turn stays held until the release manager approves
 * it; then both resolve together and run.
 */
export default defineEval({
  description: "A typed reply answers the approvals it matches and leaves the rest open.",
  tags: ["hitl", "human-input", "approval", "text-reply", "authorization"],
  timeoutMs: 60_000,
  async test(t) {
    const session = await aliceSession(t);
    const asked = await session.send(SAY.changeAAndAuthorized, asAlice);
    const a = approvalFor(asked, "change-a");
    const authorized = approvalFor(asked, "authorized-change");

    const typed = await session.send("approve", asAlice);
    expectHeld(typed);
    typed.notEvent("input.resolved");
    typed.notEvent("action.result");
    typed.notEvent("step.started");

    const settled = (
      await session.respond(answers("approve", authorized), asReleaseManager)
    ).expectOk();
    settled.event("approval.settled", {
      count: 1,
      data: { outcome: "approved", requestId: authorized.requestId },
    });
    settled.event("input.resolved", {
      count: 1,
      data: {
        resolutions: (items) =>
          [a.requestId, authorized.requestId].every((id) =>
            items.some((item) => item.requestId === id && item.outcome === "approved"),
          ),
      },
    });
    settled.calledTool("change-a", { status: "completed", count: 1 });
    settled.calledTool("authorized-change", { status: "completed", count: 1 });
  },
});
