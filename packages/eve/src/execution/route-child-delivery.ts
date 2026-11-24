import type { DeliverHookPayload } from "#channel/types.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import type { RoutedDeliverResult } from "#execution/proxied-deliver-step.js";
import type { WithSessionStateDelta } from "#execution/session/state-delta.js";
import type { SessionStepRunner } from "#execution/session/steps.js";

export async function routeDeliverToChildren(
  input: {
    readonly delivery: DeliverHookPayload;
    readonly sessionWritable: WritableStream<Uint8Array>;
    readonly sessionState: DurableSessionState;
    readonly serializedContext: Record<string, unknown>;
  },
  steps: SessionStepRunner,
): Promise<WithSessionStateDelta<RoutedDeliverResult>> {
  if (!input.sessionState.hasProxyInputRequests) {
    return { kind: "continue", remainder: input.delivery, stateDelta: {} };
  }

  return await steps.host.step("routeProxiedDeliver", input, steps.stepKey("routeProxiedDeliver"));
}
