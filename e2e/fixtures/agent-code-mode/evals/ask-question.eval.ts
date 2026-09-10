import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "A program asks the person a question, parks until they answer, and continues with the answer.",
  async test(t) {
    const parked = await t.send("CODEMODE-ASK-START");
    t.requireInputRequest({
      optionIds: ["ship", "hold"],
      prompt: "Ship the CODEMODE-ASK build?",
      toolName: "code_mode",
    });
    parked.calledTool("code_mode", { status: "pending", count: 1 });

    const answered = await t.respondAll("ship");
    answered.expectOk();
    answered.calledTool("code_mode", { count: 1, status: "completed" });
    answered.messageIncludes("CODEMODE-ASK-RESULT");
    answered.messageIncludes('"optionId":"ship"');
    answered.messageIncludes("ECHO:after-ask:ship");
    t.noFailedActions();
  },
});
