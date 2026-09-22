import { defineEval } from "eve/evals";
const NETWORK_FAILURE =
  /could ?n['o]t resolve|resolve host|could ?n['o]t connect|failed to connect|connection refused|network is unreachable|couldn't resolve host/i;

export default defineEval({
  description: "Sandbox: an open-time deny-all policy applies before authored commands run.",
  async test(t) {
    const turn = await t.send(
      "Ask the `deny-all` subagent with message: " +
        "Run the bash command `curl -sS --max-time 5 -o /dev/null https://example.com` " +
        "and reply with the command output verbatim.",
    );
    turn.expectOk();
    const sessionId = turn.sessionId;
    if (sessionId === undefined) throw new Error("Deny-all sandbox turn has no session id.");
    const completed = t.target.watchTurn(sessionId, {
      startIndex: requireStreamIndex(turn.session),
    });
    const child = await completed.result();
    child.expectOk();

    t.succeeded();
    t.calledSubagent("deny-all", { count: 1, status: "completed" });
    t.calledTool("bash", { output: { stderr: NETWORK_FAILURE } });
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Deny-all sandbox turn has no stream index.");
  return streamIndex;
}
