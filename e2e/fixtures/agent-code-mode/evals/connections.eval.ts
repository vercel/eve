import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A missing code mode search result can be resolved by direct connection discovery, followed by keyword search in the next program.",
  async test(t) {
    const turn = await t.send("CODEMODE-CONNECTIONS-START");
    turn.expectOk();
    turn.calledTool("connection_search", { count: 1, status: "completed" });
    turn.calledTool("code_mode", { count: 2, status: "completed" });
    turn.messageIncludes('"discovered":"catalog__getStatus"');
    turn.messageIncludes('"requiresDirectCall":false');
    turn.messageIncludes('"echo":"ECHO:catalog-ready"');
    t.noFailedActions();
  },
});
