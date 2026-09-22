import { defineEval } from "eve/evals";
import { includes } from "eve/evals/expect";

const TOKEN = "custom-provider-session-ok-P7M";

export default defineEval({
  description: "Sandbox: custom provider session methods survive framework lifecycle wrapping.",
  timeoutMs: 60_000,
  async test(t) {
    const turn = await t.send(
      "Ask the `custom-provider` subagent to verify its custom provider session marker.",
    );
    turn.expectOk();
    const sessionId = turn.sessionId;
    if (sessionId === undefined) throw new Error("Custom provider turn has no session id.");
    const completed = await t.target
      .watchTurn(sessionId, { startIndex: requireStreamIndex(turn.session) })
      .result();
    completed.expectOk();

    t.succeeded();
    t.calledSubagent("custom-provider", { count: 1, status: "completed" });
    t.check(completed.message, includes(TOKEN));
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Custom provider turn has no stream index.");
  return streamIndex;
}
