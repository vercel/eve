import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A Promise.all over two subagents and a tool settles concurrently and returns every value.",
  timeoutMs: 90_000,
  async test(t) {
    const turn = await t.send("CODEMODE-FANOUT-START");
    turn.expectOk();
    turn.calledTool("code_mode", { count: 1, status: "completed" });
    turn.event("subagent.called", { data: { name: "marker" }, count: 2 });
    turn.messageIncludes('"a":"MARKER:replica-0"');
    turn.messageIncludes('"b":"MARKER:replica-1"');
    turn.messageIncludes('"c":"ECHO:inline"');
    turn.eventsSatisfy("both subagents start before code_mode resolves", (events) => {
      const called = events.flatMap((event, index) =>
        event.type === "subagent.called" && event.data.name === "marker" ? [index] : [],
      );
      const toolResult = events.findIndex(
        (event) =>
          event.type === "action.result" &&
          event.data.result.kind === "tool-result" &&
          event.data.result.toolName === "code_mode",
      );
      return called.length === 2 && toolResult >= 0 && Math.max(...called) < toolResult;
    });
    t.noFailedActions();
  },
});
