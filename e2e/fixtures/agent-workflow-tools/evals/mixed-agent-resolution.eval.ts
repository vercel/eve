import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "One model step mixes waiting and background workflow tools; waiting agent results resolve inline and the background result wakes a later turn.",
  async test(t) {
    const initial = await t.send("WORKFLOW-MIXED-AGENTS-START");
    initial.expectOk();
    initial.calledTool("blocking_agent", { count: 1, status: "completed" });
    initial.calledTool("background_agent", { count: 1, status: "completed" });
    initial.event("subagent.called", { data: { name: "workflow-marker" }, count: 1 });
    initial.messageIncludes("WORKFLOW-MIXED-AGENTS-INITIAL-RESULT");
    initial.notEvent("message.received", {
      data: { message: /WORKFLOW-CHILD:api:background/u },
    });

    const sessionId = initial.sessionId;
    if (sessionId === undefined) throw new Error("Mixed workflow turn has no session id.");
    const completed = await t.target
      .watchTurn(sessionId, { startIndex: requireStreamIndex(t) })
      .result();
    completed.expectOk();
    completed.messageIncludes("WORKFLOW-REPORT-ACK");
    completed.event("message.received", { count: 1 });
    completed.eventsSatisfy("background child result wakes the later turn", (events) =>
      events.some(
        (event) =>
          event.type === "message.received" &&
          JSON.stringify(event.data.message).includes("api:background"),
      ),
    );

    t.succeeded();
    t.event("subagent.called", { data: { name: "workflow-marker" }, count: 2 });
    t.noFailedActions();
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Mixed workflow turn has no stream index.");
  return streamIndex;
}
