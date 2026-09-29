import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";
import { DIRECT_APPROVAL } from "../agent/lib/remote-direct-hitl-script.js";

export default defineEval({
  description: "Alice approves a tool called directly in her remote agent.",
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send(
      `${DIRECT_APPROVAL}: Alice asks her remote agent to review the release checklist.`,
    );
    started.expectOk();
    const pending = await waitForDirectApproval(t, started.session);
    const request = pending.requireInputRequest({ toolName: "direct_approval_gate" });
    if (request.kind !== "tool-approval")
      throw new Error("The direct remote gate was not an approval.");
    const answered = await pending.respond([{ requestId: request.requestId, optionId: "approve" }]);
    answered.expectOk();
    let session: EveEvalSession = answered.session;
    if (answered.message?.includes("PARENT-DIRECT-COMPLETE: DIRECT-APPROVAL-COMPLETE")) {
      t.calledSubagent("remote-loopback", { status: "completed", count: 1 });
      t.noFailedActions();
      return;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
      const turn = await live.result();
      turn.noFailedActions();
      if (turn.message?.includes("PARENT-DIRECT-COMPLETE: DIRECT-APPROVAL-COMPLETE")) {
        t.calledSubagent("remote-loopback", { status: "completed", count: 1 });
        t.noFailedActions();
        return;
      }
      session = live.session;
    }
    throw new Error("Direct remote approval did not return to Alice's parent session.");
  },
});

async function waitForDirectApproval(
  t: EveEvalContext,
  initial: EveEvalSession,
): Promise<EveEvalSession> {
  let session = initial;
  for (let attempt = 0; attempt < 8; attempt++) {
    if (
      session.pendingInputRequests.some(
        (request) => request.action.toolName === "direct_approval_gate",
      )
    )
      return session;
    const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
    (await live.result()).noFailedActions();
    session = live.session;
  }
  throw new Error("Direct remote approval did not reach Alice's parent session.");
}
