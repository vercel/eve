import { defineEval } from "eve/evals";
import { PREFIX_REQUEST } from "../agent/lib/prompt-prefix";

export default [false, true].map((laterTurn) =>
  defineEval({
    description: `Task announcements preserve every earlier model request as tasks are admitted (${laterTurn ? "later" : "first"} turn).`,
    async test(t) {
      if (laterTurn) {
        const ready = await t.send("Say ready.");
        ready.expectOk();
      }
      const checked = await t.send(PREFIX_REQUEST);
      checked.expectOk();
      checked.calledTool("capture_prompt", { count: 2 });
      checked.calledTool("export", { count: 2 });
      checked.messageIncludes("task-prompt-prefix-ok");
      checked.noFailedActions();
    },
  }),
);
