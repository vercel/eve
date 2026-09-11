import { defineEval } from "eve/evals";

import { DYNAMIC_ECHO_TOKEN, ECHO_TOOL } from "./shared";

// The dynamic tool must survive serialization/deserialization (lazy
// replay of the resolver): both turns call it and see the token.
export default defineEval({
  tags: ["real-model"],
  description: "A dynamic resolver registers its echo tool and preserves it across turns.",
  async test(t) {
    const first = await t.send(
      `Please call the \`${ECHO_TOOL}\` tool with message 'hello from smoke test' and tell me what it returned.`,
    );
    first.expectOk();
    first.succeeded().label("the registered dynamic echo completes before its replay turn");
    first.calledTool(ECHO_TOOL, {
      output: { echoed: "hello from smoke test", token: DYNAMIC_ECHO_TOKEN },
    });

    const second = await t.send(
      `I need you to call the \`${ECHO_TOOL}\` tool right now with message 'turn two', do not answer from memory. Call it and tell me the token from the result.`,
    );
    second.expectOk();
    second.calledTool(ECHO_TOOL, {
      output: { token: DYNAMIC_ECHO_TOKEN },
    });

    t.succeeded();
    t.calledTool(ECHO_TOOL, {
      output: { token: DYNAMIC_ECHO_TOKEN },
      count: (count) => count >= 2,
    });
  },
});
