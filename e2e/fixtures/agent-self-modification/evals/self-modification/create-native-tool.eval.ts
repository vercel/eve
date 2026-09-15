import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_greet_user";
const TOOL_TOKEN = "SELF_MOD_NATIVE_TOOL_OK";

export default defineEval({
  tags: ["real-model"],
  description:
    "Self-mod creates a greeting tool that works in new conversations for different names.",

  async test(t) {
    await withSelfModification(t, async (selfMod) => {
      await selfMod.request(
        [
          `Please add a reusable action named ${TOOL_NAME} that you can use when Alice asks for a greeting in future conversations.`,
          `It must accept a required name string and return structured data containing the name and the greeting "${TOOL_TOKEN} Hello, <name>!".`,
          "This is a pure text operation: preserve the supplied name literally and do not access files or the network.",
        ].join(" "),
      );
      await selfMod.readSource(`tools/${TOOL_NAME}.ts`);
      await selfMod.assertOnlyChanged([`tools/${TOOL_NAME}.ts`]);
      await selfMod.apply();

      for (const name of ["Alice", "Bob", "Zoë <team>"]) {
        const turn = await selfMod.verify(
          `Call ${TOOL_NAME} exactly once with ${JSON.stringify({ name })}, then report its greeting.`,
        );
        turn.requireToolCall(TOOL_NAME, {
          input: { name },
          output: { name, greeting: `${TOOL_TOKEN} Hello, ${name}!` },
        });
      }
      t.succeeded();
    });
  },
});
