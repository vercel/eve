import { defineEval, type EveEvalSession } from "eve/evals";

export default defineEval({
  description: "Parallel child agents select models from their own prompts and isolated state.",
  async test(t) {
    const first = await t.send(
      "Alice and Bob need parallel investigations assigned to the worker.",
    );
    first.expectOk();
    let session: Pick<EveEvalSession, "sessionId" | "state"> = t;
    let combined = first.message ?? "";
    for (let attempt = 0; attempt < 6; attempt++) {
      if (
        combined.includes("child-result:openai/large:1") &&
        combined.includes("child-result:openai/small:1")
      )
        return;
      if (!session.sessionId || !session.state) throw new Error("Missing parent session cursor.");
      const live = t.target.watchTurn(session.sessionId, { startIndex: session.state.streamIndex });
      const turn = await live.result();
      turn.expectOk();
      combined += turn.message ?? "";
      session = live.session;
    }
    throw new Error("Both children must report one independent model selection.");
  },
});
