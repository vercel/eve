import { defineEval } from "eve/evals";
import { equals, satisfies } from "eve/evals/expect";

import { callMcpTool, pollInvocation, type McpInvocation } from "./mcp-client";

/**
 * An MCP client starts the delegating script with `agent_start`. The root
 * agent's turn holds while `workflow-stager` works, so its interim text is not
 * the answer: `agent_get` reports `working` until the turn really ends, then
 * `completed` with the final reply.
 */
export default defineEval({
  description: "MCP agent_start with a delegating agent reports only the final reply.",
  async test(t) {
    const started = await callMcpTool(t.target, "agent_start", {
      message: "WORKFLOW-DELEGATE-STAGE Stage api through workflow-stager and report back.",
    });
    const states = await pollInvocation(t.target, started.invocationId, 60_000);
    const settled = states.at(-1)!;

    await t.require(settled.status, equals("completed"));
    t.check(
      settled.result,
      satisfies(
        (result: unknown) =>
          typeof result === "string" &&
          result.startsWith("WORKFLOW-DELEGATE-RESULT WORKFLOW-CHILD-STAGED "),
        "the completed result is the final reply",
      ),
    );
    t.check(
      states.slice(0, -1),
      satisfies(
        (earlier: readonly McpInvocation[]) => earlier.every((state) => state.status === "working"),
        "the invocation stays working while the turn is held",
      ),
    );
  },
});
