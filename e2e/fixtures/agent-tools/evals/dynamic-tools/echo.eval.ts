import { defineEval } from "eve/evals";

import { DYNAMIC_ECHO_TOKEN, ECHO_TOOL } from "./shared.js";

// defineDynamic resolves at session.started; the tool is called and
// returns the fixture token.
export default defineEval({
  description: "Dynamic tools smoke: resolver registers the echo tool and it returns the token.",
  async test(t) {
    await t.send(
      `Please call the \`${ECHO_TOOL}\` tool with message 'hello from smoke test' and tell me what it returned.`,
    );

    t.succeeded();
    t.calledTool(ECHO_TOOL, {
      output: { echoed: "hello from smoke test", token: DYNAMIC_ECHO_TOKEN },
    });
  },
});
