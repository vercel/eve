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
    const request = pending.requireInteraction({ toolName: "direct_approval_gate" });
    if (request.request.kind !== "approval")
      throw new Error("The direct remote gate was not an approval.");
    const answered = await pending.respond([
      { interactionId: request.interactionId, optionId: "approve" },
    ]);
    answered.expectOk();
    let session: EveEvalSession = answered.session;
    if (answered.reply?.includes("PARENT-DIRECT-COMPLETE: DIRECT-APPROVAL-COMPLETE")) {
      t.calledAgent("remote-loopback", { status: "completed", count: 1 });
      t.noFailedCalls();
      return;
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const live = t.target.attach(session.id, { startIndex: session.state.streamIndex }).watch();
      const turn = await live.result();
      turn.noFailedCalls();
      if (turn.reply?.includes("PARENT-DIRECT-COMPLETE: DIRECT-APPROVAL-COMPLETE")) {
        t.calledAgent("remote-loopback", { status: "completed", count: 1 });
        t.noFailedCalls();
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
      session.pendingInteractions.some((request) => request.call?.name === "direct_approval_gate")
    )
      return session;
    const live = t.target.attach(session.id, { startIndex: session.state.streamIndex }).watch();
    (await live.result()).noFailedCalls();
    session = live.session;
  }
  throw new Error("Direct remote approval did not reach Alice's parent session.");
}
