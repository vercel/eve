import { defineEval, type EveEvalContext, type EveEvalSession } from "eve/evals";
import { REMOTE_QUESTION_DIRECTIVE } from "../agent/lib/remote-question-script.js";

export default defineEval({
  description: "Alice answers a remote workflow question through the parent session.",
  timeoutMs: 90_000,
  async test(t) {
    const started = await t.send(`${REMOTE_QUESTION_DIRECTIVE}: ask Alice for her approval word.`);
    started.expectOk();
    const pending = await waitForInput(t, started.session);
    const request = pending.requireInteraction({ toolName: "remote_question" });
    if (
      request.request.kind !== "question" ||
      request.request.prompt !== "What is Alice's approval word?"
    ) {
      throw new Error("Remote workflow question did not reach the parent.");
    }
    const answered = await pending.respond([
      { interactionId: request.interactionId, text: "alice-ok" },
    ]);
    answered.expectOk();
    const completion = answered.reply?.includes("PARENT-QUESTION-COMPLETE")
      ? answered
      : await t.target
          .attach(pending.id, { startIndex: pending.state.streamIndex })
          .watch()
          .result();
    completion.messageIncludes("PARENT-QUESTION-COMPLETE: REMOTE-QUESTION-COMPLETE");
    t.calledAgent("remote-loopback", { count: 1, status: "completed" });
    t.noFailedCalls();
  },
});

async function waitForInput(t: EveEvalContext, initial: EveEvalSession): Promise<EveEvalSession> {
  let session = initial;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (session.pendingInteractions.some((request) => request.call?.name === "remote_question"))
      return session;
    const turn = await t.target
      .attach(session.id, { startIndex: session.state.streamIndex })
      .watch()
      .result();
    turn.noFailedCalls();
    session = turn.session;
  }
  throw new Error("Remote workflow tool did not ask Alice.");
}
