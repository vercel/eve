import { defineEval } from "eve/evals";

/** Workflow calls block, can continue one child, and share one subagent budget. */
export default defineEval({
  tags: ["real-model"],
  description:
    "Workflow sandbox agent calls return inline, reuse agentId, and enforce maxSubagents.",
  async test(t) {
    const started = await t.send(
      [
        "Use the Workflow tool exactly once and call echo-marker inside it with message 'blocking first'.",
        "Return the inline result and reply with it verbatim. Do not call echo-marker outside Workflow.",
      ].join(" "),
    );
    started.expectOk();
    const firstTurn = t.target.watchTurn(started.sessionId, {
      startIndex: requireStreamIndex(t),
    });
    const completed = await firstTurn.result();
    completed.expectOk();
    completed.messageIncludes("SUBAGENT_TOKEN=echo-marker-9F2X");

    const second = await firstTurn.session.send(
      [
        "Use the Workflow tool exactly once. In its JavaScript, call the same echo-marker child twice sequentially",
        "using the agentId shown in the latest <agents> block, with messages 'blocking second' and 'blocking third'.",
        "Then attempt a third call with that agentId and message 'blocking over limit'.",
        "Return all three inline results and reply with them verbatim as JSON. Do not call echo-marker outside Workflow.",
      ].join(" "),
    );
    second.expectOk();

    t.succeeded();
    t.calledTool("Workflow", { count: 2 });
    t.calledSubagent("echo-marker", { count: 3 });
    t.eventsSatisfy("all Workflow calls continue one child session", (events) => {
      const childSessionIds = events.flatMap((event) =>
        event.type === "subagent.called" && event.data.name === "echo-marker"
          ? [event.data.childSessionId]
          : [],
      );
      return (
        childSessionIds.length === 3 &&
        childSessionIds[0] !== undefined &&
        childSessionIds.every((sessionId) => sessionId === childSessionIds[0])
      );
    });
    t.messageIncludes("SUBAGENT_TOKEN=echo-marker-9F2X");
    t.messageIncludes("WORKFLOW_SUBAGENT_LIMIT_REACHED");
  },
});

function requireStreamIndex(session: {
  readonly state?: { readonly streamIndex?: number };
}): number {
  const streamIndex = session.state?.streamIndex;
  if (streamIndex === undefined) throw new Error("Parent session has no stream index.");
  return streamIndex;
}
