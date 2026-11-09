import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import { contentAttribute } from "#compiled/@vercel/agent-runs/otel.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { isSampledTrace } from "#shared/trace-policy.js";
import { enteredView } from "#harness/session-machine/current.js";
import { contextStorage } from "#context/container.js";

/** Attribute a turn only when exactly one message delivery was consumed, across workers. */
export function createAgentChannelDeliveryInstrumentation(input: {
  readonly recordInputs: boolean;
  readonly stateStore: AgentTraceStateStore;
}): Pick<NonNullable<InstrumentationProviderDefinition["events"]>, "delivery.consumed"> {
  return {
    async "delivery.consumed"(event) {
      if (event.turnId === undefined) return;
      // Answer-only deliveries resume the original request; they do not replace its attribution.
      const ctx = contextStorage.getStore();
      if (ctx !== undefined && enteredView(ctx)?.deliveries[event.deliveryId]?.parts?.length === 0)
        return;
      await input.stateStore.update(
        "turn",
        JSON.stringify([event.sessionId, event.turnId]),
        (turn) => {
          if (!isSampledTrace(turn.context) || turn.consumedDeliveryId === null) return turn;
          if (
            turn.consumedDeliveryId !== undefined &&
            turn.consumedDeliveryId !== event.deliveryId
          ) {
            return { ...turn, channelDelivery: undefined, consumedDeliveryId: null };
          }
          return {
            ...turn,
            consumedDeliveryId: event.deliveryId,
            channelDelivery:
              event.delivery === undefined
                ? undefined
                : {
                    ...event.delivery,
                    inputAttribute: input.recordInputs ? contentAttribute(event.input) : undefined,
                  },
          };
        },
      );
    },
  };
}
