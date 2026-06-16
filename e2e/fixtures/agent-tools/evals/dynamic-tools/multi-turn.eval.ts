import { defineEval } from "eve/evals";

import { DYNAMIC_ECHO_TOKEN, ECHO_TOOL, requireToolOutput } from "./shared.js";

// The dynamic tool must survive serialization/deserialization (lazy
// replay of the resolver): both turns call it and see the token.
export default defineEval({
  description: "Dynamic tools smoke: the dynamic tool survives serialization across turns.",
  async test(t) {
    const first = await t.send(
      `Please call the \`${ECHO_TOOL}\` tool with message 'turn one' and tell me the token it returned.`,
    );
    first.expectOk();
    if (requireToolOutput(first, ECHO_TOOL).token !== DYNAMIC_ECHO_TOKEN) {
      throw new Error("Turn 1: echo tool result did not contain the expected token.");
    }

    const second = await t.send(
      `I need you to call the \`${ECHO_TOOL}\` tool right now with message 'turn two', do not answer from memory. Call it and tell me the token from the result.`,
    );
    second.expectOk();
    if (requireToolOutput(second, ECHO_TOOL).token !== DYNAMIC_ECHO_TOKEN) {
      throw new Error(
        "Turn 2: echo tool result did not contain the expected token. " +
          "The dynamic tool may not have survived serialization.",
      );
    }

    t.didNotFail();
    t.completed();
    t.calledTool(ECHO_TOOL, {
      isError: false,
      output: { token: DYNAMIC_ECHO_TOKEN },
      times: 2,
    });
  },
});
