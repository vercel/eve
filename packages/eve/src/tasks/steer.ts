import type { ContextContainer } from "#context/container.js";
import type { RuntimeToolResultActionResult } from "#shared/action-types.js";
import { steeringReceiptResult } from "#tasks/receipts.js";
import type { StartTaskResult } from "#tasks/table.js";
import { sendAgentMessage } from "#tasks/transport.js";

/**
 * Resolves a model call that named a working agent. Its message joins the
 * agent's current generation: no generation starts, no `task.started` is
 * published, and the generation's one result still reaches its original
 * caller. The call returns the steering receipt at once. A child that has not
 * started yet gets the message when it reports `task.started`.
 */
export async function steerWorkingAgent(input: {
  readonly callId: string;
  readonly ctx: ContextContainer;
  readonly steered: Extract<StartTaskResult, { readonly kind: "steered" }>;
  readonly toolName: string;
}): Promise<RuntimeToolResultActionResult> {
  for (const effect of input.steered.transition.effects) {
    if (effect.kind !== "send") continue;
    for (const command of effect.commands) {
      if (command.kind !== "message") continue;
      const failure = await sendAgentMessage({ command, ctx: input.ctx, record: effect.record });
      if (failure === undefined) continue;
      return {
        callId: input.callId,
        isError: true,
        kind: "tool-result",
        output: failure,
        toolName: input.toolName,
      };
    }
  }
  return steeringReceiptResult({
    callId: input.callId,
    record: input.steered.record,
    toolName: input.toolName,
  });
}
