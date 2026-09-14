import { defineEval } from "eve/evals";

const GIZMO_INSTRUCTIONS_TOKEN = "gizmo-instructions-ok-7K2M";
const JAVASCRIPT_INSTRUCTIONS_TOKEN = "javascript-instructions-ok-9P4R";

export default defineEval({
  description: "Flat instructions from multiple extensions coexist on one agent.",
  async test(t) {
    await t.send(
      "Report both extension instruction tokens exactly. Do not call tools or add other text.",
    );

    t.succeeded();
    t.messageIncludes(GIZMO_INSTRUCTIONS_TOKEN);
    t.messageIncludes(JAVASCRIPT_INSTRUCTIONS_TOKEN);
  },
});
