import { defineEval } from "eve/evals";
import type { HandleMessageStreamEvent } from "eve/client";

const DYNAMIC_GUARDED_ECHO_TOKEN = "dynamic-guarded-echo-ok-L8R6";
const TOOL_NAME = "dynamic_guarded_echo";

/**
 * HITL flow: a session-scoped dynamic tool's approval gate survives durable
 * replay. If replay drops `approval`, the tool executes immediately and
 * this eval fails before approval.
 */
export default defineEval({
  description: "HITL smoke: replayed dynamic tools preserve approval.",
  async test(t) {
    await t.send(`Call the \`${TOOL_NAME}\` tool with note "before-approval".`);
    const [request] = t.expectInputRequests({
      display: "confirmation",
      toolName: TOOL_NAME,
    });
    if (request === undefined) {
      throw new Error(`Expected ${TOOL_NAME} to park for approval.`);
    }
    if (dynamicGuardedEchoResults(t.events).length > 0) {
      throw new Error(`${TOOL_NAME} executed before approval.`);
    }

    const approved = await t.respondAll("approve");
    approved.expectOk();
    const results = dynamicGuardedEchoResults(t.events);
    if (results.length !== 1 || !results[0]!.includes(DYNAMIC_GUARDED_ECHO_TOKEN)) {
      throw new Error(`Approved ${TOOL_NAME} call did not execute with the expected token.`);
    }

    t.didNotFail();
    t.completed();
  },
});

function dynamicGuardedEchoResults(events: readonly HandleMessageStreamEvent[]): string[] {
  const results: string[] = [];
  for (const event of events) {
    if (event.type !== "action.result") continue;
    if (event.data.status === "rejected") continue;
    const result = event.data.result;
    if (result.kind !== "tool-result" || result.toolName !== TOOL_NAME) continue;
    results.push(JSON.stringify(result.output ?? ""));
  }
  return results;
}
