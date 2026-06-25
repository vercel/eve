import { defineEval } from "eve/evals";

import { DYNAMIC_ECHO_TOKEN, ECHO_TOOL } from "./shared.js";

// The dynamic tool must survive serialization/deserialization (lazy
// replay of the resolver): both turns call it and see the token.
export default defineEval({
  description: "Dynamic tools smoke: the dynamic tool survives serialization across turns.",
  async test(t) {
    const first = await t.send(
      `Please call the \`${ECHO_TOOL}\` tool with message 'turn one' and tell me the token it returned.`,
    );
    first.expectOk();
    first.calledTool(ECHO_TOOL, {
      output: { token: DYNAMIC_ECHO_TOKEN },
    });

    const second = await t.send(
      `I need you to call the \`${ECHO_TOOL}\` tool right now with message 'turn two', do not answer from memory. Call it and tell me the token from the result.`,
    );
    second.calledTool(ECHO_TOOL, {
      output: { token: DYNAMIC_ECHO_TOKEN },
    });

    t.succeeded();
    t.calledTool(ECHO_TOOL, {
      output: { token: DYNAMIC_ECHO_TOKEN },
      count: 2,
    });
  },
});
