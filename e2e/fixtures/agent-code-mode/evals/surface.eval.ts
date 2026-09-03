import { defineEval } from "eve/evals";

export default defineEval({
  description:
    "code_mode replaces claimable tools on the model surface; approval-gated tools stay direct.",
  async test(t) {
    const turn = await t.send("CODEMODE-SURFACE-START");
    turn.expectOk();
    // Everything code_mode claimed (echo, marker) is gone; the approval-gated
    // tool and the framework's own tools stay direct.
    turn.messageIncludes(
      /CODEMODE-SURFACE-RESULT \[ask_question,code_mode,gated,load_skill,task_cancel\]/u,
    );
  },
});
