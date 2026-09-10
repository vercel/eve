import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "Declining an in-program approval rejects that JavaScript call with CODE_MODE_APPROVAL_DENIED, which the program can catch.",
  async test(t) {
    const parked = await t.send("CODEMODE-DENY-START");
    t.requireInputRequest({ optionIds: ["approve", "cancel"], toolName: "gated" });
    parked.calledTool("code_mode", { status: "pending", count: 1 });

    const done = await t.respondAll("cancel");
    done.expectOk();
    done.calledTool("code_mode", { count: 1, status: "completed" });
    done.messageIncludes("CODEMODE-DENY-RESULT");
    done.messageIncludes('"denied":true');
    t.noFailedActions();
  },
});
