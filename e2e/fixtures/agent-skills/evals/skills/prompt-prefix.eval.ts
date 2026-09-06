import { defineEval } from "eve/evals";
import { PREFIX_REQUEST } from "../../agent/lib/prompt-prefix";

export default defineEval({
  description: "Dynamic skill announcements preserve the prompt prefix across durable tool steps.",
  async test(t) {
    const first = await t.send("Say ready.");
    first.expectOk();
    const checked = await t.send(PREFIX_REQUEST);
    checked.expectOk();
    checked.calledTool("capture_prompt");
    checked.messageIncludes("prompt-prefix-ok");
  },
});
