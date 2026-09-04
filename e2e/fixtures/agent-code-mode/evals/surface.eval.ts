import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "code_mode claims dynamic tools and subagents; approval and ordinary background tools stay direct.",
  async test(t) {
    const turn = await t.send("CODEMODE-SURFACE-START");
    turn.expectOk();
    turn.messageIncludes(
      /CODEMODE-SURFACE-RESULT \[ask_question,background,code_mode,connection_search,gated,load_skill,task_cancel\]/u,
    );
  },
});
