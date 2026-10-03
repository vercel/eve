import { defineEval } from "eve/evals";

import {
  RELEASE_MANAGER,
  SAY,
  aliceSession,
  answers,
  approvalFor,
  asAlice,
  asReleaseManager,
  completeSignIn,
  expectHeld,
  expectNoModelCallDuringSignIn,
  expectResolved,
  follow,
  signInFrom,
} from "../helpers.ts";

/**
 * The release manager approves the OAuth-checked change. Its policy needs
 * the approver signed in first, so the turn holds on the release manager's
 * sign-in; the callback runs the policy again, which settles the approval as
 * the release manager and runs the change.
 */
export default defineEval({
  description: "A response policy that needs the responder to sign in settles after the sign-in.",
  tags: ["hitl", "human-input", "authorization", "sign-in"],
  timeoutMs: 90_000,
  async test(t) {
    const session = await aliceSession(t);
    const request = approvalFor(
      await session.send(SAY.oauthChecked, asAlice),
      "oauth-authorized-gate",
    );

    const held = await session.respond(answers("approve", request), asReleaseManager);
    expectHeld(held);
    held.event("approval.candidate", { count: 1, data: { outcome: "pending" } });
    held.event("authorization.required", { count: 1, data: { principalId: RELEASE_MANAGER } });
    held.notEvent("approval.settled");
    const signIn = signInFrom(held);

    const startIndex = session.state.streamIndex;
    await completeSignIn(signIn.url);
    const resumed = (await follow(t, session, startIndex)).expectOk();
    resumed.notEvent("turn.started");
    resumed.eventOrder([
      {
        type: "authorization.completed",
        data: { attemptId: signIn.attemptId, outcome: "authorized" },
      },
      {
        type: "approval.settled",
        data: { outcome: "approved", responderPrincipalId: RELEASE_MANAGER },
      },
      {
        type: "action.result",
        data: { status: "completed", result: { toolName: "oauth-authorized-gate" } },
      },
      { type: "message.completed", data: { message: /^OAuth-checked change: done / } },
      { type: "turn.completed" },
    ]);
    expectResolved(resumed, request, "approved");
    expectNoModelCallDuringSignIn(resumed, signIn.attemptId, held.events);
  },
});
