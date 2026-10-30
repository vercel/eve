import type { DeliverPayload } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { ChannelDeliveryKey, SessionTraceSeedKey } from "#context/keys.js";
import type { CreateInstrumentationHandleEventInput } from "#instrumentation/native-events.js";
import type { InstrumentationEvent } from "#instrumentation/lifecycle.js";
import { channelDeliveryIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { SessionEvent } from "#protocol/session-event.js";

export function deliveryEvent(
  event: SessionEvent,
  ctx: AlsContext | undefined,
  session: CreateInstrumentationHandleEventInput,
): InstrumentationEvent | undefined {
  if (event.type !== "delivery.consumed" && event.type !== "delivery.settled") return;
  const { deliveryId, turnId } = event.data;
  const idempotencyKey = channelDeliveryIdempotencyKey(session.sessionId, deliveryId);
  if (event.type === "delivery.settled") {
    return { ...event.data, idempotencyKey, sessionId: session.sessionId, type: event.type };
  }
  const raw = session.deliveryInput;
  const metadata = raw?.deliveryMetadata?.find((item) => item.deliveryId === deliveryId);
  const fallback = ctx?.get(ChannelDeliveryKey);
  const channel = metadata ?? (fallback?.deliveryId === deliveryId ? fallback : undefined);
  const payload = metadata === undefined ? undefined : raw?.payloads[metadata.payloadIndex];
  return {
    agentName: session.agentName,
    deliveryId,
    delivery:
      channel === undefined
        ? undefined
        : {
            channelAudience: session.channelAudience,
            channelKind: channel.channelKind,
            channelName: channel.channelName,
            deliveryId,
            requestId: channel.requestId,
            requestTraceContext: channel.requestTraceContext,
          },
    idempotencyKey,
    input:
      session.hooks?.capturesInputs || session.hooks?.capturesContent
        ? payload === undefined
          ? { message: event.data.parts }
          : projectDeliveryInput(payload)
        : undefined,
    rootSessionId: session.rootSessionId ?? session.sessionId,
    sessionId: session.sessionId,
    traceSeed: ctx?.get(SessionTraceSeedKey),
    traceSessionId: session.traceSessionId,
    turnId,
    type: "delivery.consumed",
  };
}

function projectDeliveryInput(payload: DeliverPayload) {
  return {
    context: payload.context,
    message: payload.message,
    outputSchema: payload.outputSchema,
    answers: payload.answers?.map(({ optionId, text }) => ({ optionId, text })),
  };
}
