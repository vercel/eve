import { defineEval } from "eve/evals";

/** Generated workflow-program calls block, continue one child, and share one call budget. */
export default defineEval({
  tags: ["real-model"],
  description:
    "Generated workflow-program agent calls return inline, reuse taskId, and enforce maxSubagents.",
  async test(t) {
    const started = await t.send(
      [
        "Use the workflow tool exactly once and call ctx.agent for echo-marker inside it with message 'blocking first'.",
        "Return the inline result and reply with it verbatim. Do not call echo-marker outside workflow.",
      ].join(" "),
    );
    started.expectOk();
    const firstTurn = started.message?.includes("SUBAGENT_TOKEN=echo-marker-9F2X")
      ? undefined
      : t.target.watchTurn(started.sessionId, {
          startIndex: started.session.state.streamIndex,
        });
    const completed = firstTurn === undefined ? started : await firstTurn.result();
    completed.expectOk();
    completed.messageIncludes("SUBAGENT_TOKEN=echo-marker-9F2X");

    const second = await completed.session.send(
      [
        "Use the workflow tool exactly once. In its JavaScript, call the same echo-marker child three times sequentially with ctx.agent",
        "using the agent id shown in the latest [Tasks] note, with messages 'blocking second', 'blocking third', and 'blocking fourth'.",
        "Then attempt a fourth call with that taskId and message 'blocking over limit'.",
        "Catch the fourth call's error, return all three inline results followed by its message, and reply with that four-element array verbatim as JSON. Do not call echo-marker outside workflow.",
      ].join(" "),
    );
    second.expectOk();

    t.succeeded();
    t.calledTool("workflow", { count: 2 });
    t.calledSubagent("echo-marker", { count: 4, status: "completed" });
    t.eventsSatisfy("all workflow-program calls continue one child session", (events) => {
      const childSessionIds = events.flatMap((event) =>
        event.type === "task.started" && event.data.name === "echo-marker"
          ? [event.data.child?.sessionId]
          : [],
      );
      return (
        childSessionIds.length === 4 &&
        childSessionIds[0] !== undefined &&
        childSessionIds.every((sessionId) => sessionId === childSessionIds[0])
      );
    });
    t.messageIncludes("SUBAGENT_TOKEN=echo-marker-9F2X");
    t.messageIncludes("WORKFLOW_PROGRAM_SUBAGENT_LIMIT_REACHED");
  },
});
