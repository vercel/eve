import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A program calls approval-gated tools: each call asks the person as a tool approval, and a once() approval covers later calls in the same program.",
  async test(t) {
    const parked = await t.send("CODEMODE-APPROVAL-START");
    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      prompt: "Approve tool call: gated",
      toolName: "gated",
    });
    parked.calledTool("code_mode", { status: "pending", count: 1 });

    const second = await t.respondAll("approve");
    t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "cancel"],
      toolName: "gated_once",
    });
    second.calledTool("code_mode", { status: "pending", count: 1 });

    const done = await t.respondAll("approve");
    done.expectOk();
    done.calledTool("code_mode", { count: 1, status: "completed" });
    done.messageIncludes("CODEMODE-APPROVAL-RESULT");
    done.messageIncludes('"first":"GATED"');
    done.messageIncludes('"second":"GATED-ONCE"');
    done.messageIncludes('"third":"GATED-ONCE"');
    t.noFailedActions();
  },
});
