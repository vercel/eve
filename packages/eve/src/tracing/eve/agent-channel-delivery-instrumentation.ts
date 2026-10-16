import type { InstrumentationProviderDefinition } from "#instrumentation/lifecycle.js";
import { contentAttribute } from "#compiled/@eve/tracing/otel.js";
import type { AgentTraceStateStore } from "#tracing/eve/agent-trace-state.js";
import { isSampledTrace } from "#shared/trace-policy.js";

/** Attribute a turn only when exactly one delivery was consumed, including across workers. */
export function createAgentChannelDeliveryInstrumentation(input: {
  readonly recordInputs: boolean;
  readonly stateStore: AgentTraceStateStore;
}): Pick<NonNullable<InstrumentationProviderDefinition["events"]>, "delivery.consumed"> {
  return {
    async "delivery.consumed"(event) {
      if (event.turnId === undefined) return;
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
