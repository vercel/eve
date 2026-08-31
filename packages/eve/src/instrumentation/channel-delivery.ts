import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import {
  ActiveChannelDeliveriesKey,
  ChannelInstrumentationKey,
  ParentTraceContextKey,
  SessionTraceSeedKey,
  type ActiveChannelDelivery,
} from "#context/keys.js";
import type {
  InstrumentationChannelDeliveryOutcome,
  InstrumentationChannelDeliveryTerminalEvent,
  InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import { channelDeliveryIdempotencyKey } from "#instrumentation/lifecycle.js";
import { normalizeChannelAudience } from "#shared/channel-audience.js";

export interface ChannelDeliveryStartInstrumentation {
  readonly agentName?: string;
  readonly ctx: AlsContext;
  readonly delivery: DeliverHookPayload;
  readonly hooks: InstrumentationHooks | undefined;
  readonly policyAgentName: string;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface ChannelDeliveryTerminalInstrumentation {
  readonly ctx: AlsContext;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly hooks: InstrumentationHooks | undefined;
  readonly includeTurn: boolean;
  readonly outcome: InstrumentationChannelDeliveryOutcome;
}

export async function instrumentChannelDelivery(
  input: ChannelDeliveryStartInstrumentation | ChannelDeliveryTerminalInstrumentation,
): Promise<void> {
  if (!("delivery" in input)) {
    const active = input.ctx.get(ActiveChannelDeliveriesKey);
    if (active === undefined || input.hooks === undefined) return;
    const type =
      `channel.delivery.${input.outcome}` as InstrumentationChannelDeliveryTerminalEvent["type"];
    for (const item of active) {
      const policyAgentName = item.policyAgentName ?? item.agentName;
      if (policyAgentName === undefined) continue;
      const hooks =
        input.hooks.forTrace?.({
          agentName: policyAgentName,
          audience: normalizeChannelAudience(item.delivery.channelAudience),
          channelType: item.channelType,
        }) ?? input.hooks;
      await hooks.publish({
        agentName: item.agentName,
        delivery: item.delivery,
        error: input.error,
        errorCode: input.errorCode,
        idempotencyKey: channelDeliveryIdempotencyKey(item.sessionId, item.delivery.deliveryId),
        outcome: input.outcome,
        rootSessionId: item.rootSessionId,
        sequence: input.includeTurn ? item.sequence : undefined,
        sessionId: item.sessionId,
        turnId: input.includeTurn ? item.turnId : undefined,
        type,
      });
    }
    input.ctx.delete(ActiveChannelDeliveriesKey);
    return;
  }

  if (input.hooks === undefined || input.delivery.deliveryMetadata === undefined) return;

  const active: ActiveChannelDelivery[] = [];
  const channel = input.ctx.get(ChannelInstrumentationKey);
  const channelAudience = normalizeChannelAudience(channel?.metadata.audience);
  const hooks =
    input.hooks.forTrace?.({
      agentName: input.policyAgentName,
      audience: channelAudience,
      channelType: channel?.channelType,
    }) ?? input.hooks;
  for (const metadata of input.delivery.deliveryMetadata) {
    const payload = input.delivery.payloads[metadata.payloadIndex];
    const delivery = {
      channelAudience,
      channelKind: metadata.channelKind,
      channelName: metadata.channelName,
      deliveryId: metadata.deliveryId,
      requestId: metadata.requestId,
      requestTraceContext: metadata.requestTraceContext,
    };
    const capturesInputs = hooks.capturesInputs ?? hooks.capturesContent;
    const deliveryInput =
      !capturesInputs || payload === undefined ? undefined : projectDeliveryInput(payload);
    const item: ActiveChannelDelivery = {
      agentName: input.agentName,
      channelType: channel?.channelType,
      delivery,
      policyAgentName: input.policyAgentName,
      rootSessionId: input.rootSessionId,
      sequence: input.sequence,
      sessionId: input.sessionId,
      turnId: input.turnId,
    };
    active.push(item);
    await hooks?.publish({
      agentName: item.agentName,
      delivery,
      idempotencyKey: channelDeliveryIdempotencyKey(input.sessionId, delivery.deliveryId),
      input: deliveryInput,
      parentTraceContext: input.ctx.get(ParentTraceContextKey),
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
      traceSeed: input.ctx.get(SessionTraceSeedKey),
      type: "channel.delivery.started",
    });
  }
  if (active.length > 0) input.ctx.set(ActiveChannelDeliveriesKey, active);
}

function projectDeliveryInput(payload: DeliverPayload) {
  const projected: {
    context?: DeliverPayload["context"];
    inputResponses?: Array<{ optionId?: string; text?: string }>;
    message?: DeliverPayload["message"];
    outputSchema?: DeliverPayload["outputSchema"];
  } = {};
  if (payload.context !== undefined) projected.context = payload.context;
  if (payload.message !== undefined) projected.message = payload.message;
  if (payload.outputSchema !== undefined) projected.outputSchema = payload.outputSchema;
  if (payload.inputResponses !== undefined) {
    projected.inputResponses = payload.inputResponses.map((response) => {
      const item: { optionId?: string; text?: string } = {};
      if (response.optionId !== undefined) item.optionId = response.optionId;
      if (response.text !== undefined) item.text = response.text;
      return item;
    });
  }
  return projected;
}
