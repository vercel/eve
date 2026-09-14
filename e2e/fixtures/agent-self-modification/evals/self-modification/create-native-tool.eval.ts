import { defineEval } from "eve/evals";

import { withSelfModification } from "./harness";

const TOOL_NAME = "eval_greet_user";
const TOOL_SOURCE_PATH = `tools/${TOOL_NAME}.ts`;
const TOOL_SANDBOX_PATH = `/source/${TOOL_SOURCE_PATH}`;
const TOOL_TOKEN = "SELF_MOD_NATIVE_TOOL_OK";
const SELF_MODIFICATION_INSTRUCTIONS = "subagents/self-modification/instructions.md";
const AUTHORING_INSTRUCTIONS =
  "Follow your extension instructions normally and complete the requested source modification.";

export default defineEval({
  tags: ["real-model"],
  description:
    "A root model routes a persistent capability request to self-mod, which creates a callable eve tool.",

  async test(t) {
    if (process.env.EVE_E2E_MODEL !== "openai/gpt-5.6-sol") {
      t.skip("The routing eval covers the root-model matrix; tool authoring runs once.");
    }

    await withSelfModification(
      t,
      [TOOL_SOURCE_PATH, SELF_MODIFICATION_INSTRUCTIONS],
      async (selfMod) => {
        await selfMod.writeSource(SELF_MODIFICATION_INSTRUCTIONS, AUTHORING_INSTRUCTIONS);
        await selfMod.apply();

        const { child } = await selfMod.request(
          [
            `Please add a reusable action named ${TOOL_NAME} that you can use when Alice asks for a greeting in future conversations.`,
            `It must accept a required name string and return structured data containing the name and the greeting "${TOOL_TOKEN} Hello, <name>!".`,
          ].join(" "),
        );
        child.calledTool("write_file", {
          input: { filePath: TOOL_SANDBOX_PATH },
          output: { existed: false, path: TOOL_SANDBOX_PATH },
          count: 1,
        });

        const source = await selfMod.readSource(TOOL_SOURCE_PATH);
        if (
          !/from\s+["']eve\/tools["']/u.test(source) ||
          !/export\s+default\s+defineTool\s*\(/u.test(source)
        ) {
          throw new Error(`${TOOL_SANDBOX_PATH} is not an authored eve tool definition.`);
        }

        await selfMod.apply();

        const followUp = await t.send(
          `Call ${TOOL_NAME} exactly once with the name Alice, then reply with only its greeting.`,
        );
        followUp.expectOk();
        followUp.calledTool(TOOL_NAME, { count: 1 });
        followUp.calledTool(TOOL_NAME, {
          input: { name: "Alice" },
          output: { name: "Alice", greeting: `${TOOL_TOKEN} Hello, Alice!` },
        });
        followUp.messageIncludes(`${TOOL_TOKEN} Hello, Alice!`);

        t.succeeded();
      },
    );
  },
});
