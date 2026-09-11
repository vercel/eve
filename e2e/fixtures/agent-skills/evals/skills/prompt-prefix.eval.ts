import { defineEval } from "eve/evals";
import { PREFIX_REQUEST } from "../../agent/lib/prompt-prefix";

const DYNAMIC_INSTRUCTIONS_TOKEN = "dynamic-instructions-ok-M3K8";

// Session-start dynamic user instructions must reach the ordinary first
// reply before the later request switches to the prompt-prefix checking model.
export default defineEval({
  description:
    "Dynamic user instructions reach the first turn and skill announcements preserve the later prompt prefix.",
  async test(t) {
    const first = await t.send("Say ready.");
    first.expectOk();
    first.succeeded();
    first.messageIncludes(DYNAMIC_INSTRUCTIONS_TOKEN);
    const checked = await t.send(PREFIX_REQUEST);
    checked.expectOk();
    checked.calledTool("capture_prompt");
    checked.messageIncludes("prompt-prefix-ok");
    t.succeeded();
  },
});
