import { defineEval } from "eve/evals";

export default defineEval({
  description: "code_mode launches a tasks-enabled subagent and returns its working receipt.",
  async test(t) {
    await t.send("CODEMODE-TASK-LAUNCH");

    t.succeeded();
    t.calledTool("code_mode", {
      count: 1,
      output: {
        agentId: /^ag_/u,
        status: "working",
        taskId: /^task_/u,
      },
    });
    t.calledSubagent("receipt-worker", { count: 1 });
    t.event("subagent.completed", {
      count: 1,
      data: {
        backgroundTask: { status: "working" },
        subagentName: "receipt-worker",
      },
    });
    t.notCalledTool("delay");
    t.messageIncludes("CODEMODE-TASK-RECEIPT");
  },
});
