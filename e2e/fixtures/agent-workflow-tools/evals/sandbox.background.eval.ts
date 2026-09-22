import { defineEval } from "eve/evals";

export default defineEval({
  description: "A background workflow reconnects to the session sandbox across steps.",
  async test(t) {
    const started = await t.send("WORKFLOW-SANDBOX-BACKGROUND-START");
    started.expectOk();
    started.calledTool("sandbox_background", { status: "completed", count: 1 });
    const { sessionId, state } = started.session;
    if (sessionId === undefined || state?.streamIndex === undefined) {
      throw new Error("Sandbox probe has no session stream cursor.");
    }
    const next = t.target.watchTurn(sessionId, { startIndex: state.streamIndex });
    const completed = await next.result();
    completed.expectOk();
    completed.messageIncludes("workflow-sandbox:api");
    completed.messageIncludes('"sameSandbox":true');
    completed.messageIncludes('"commandExitCode":0');
    t.noFailedActions();
  },
});
