import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { AlsContext } from "#context/container.js";
import { ActiveChannelDeliveriesKey, type ActiveChannelDelivery } from "#context/keys.js";
import type {
  InstrumentationChannelDeliveryOutcome,
  InstrumentationChannelDeliveryTerminalEvent,
  InstrumentationHooks,
} from "#instrumentation/lifecycle.js";
import { channelDeliveryIdempotencyKey } from "#instrumentation/lifecycle.js";
import type { SessionInstrumentation } from "#instrumentation/session-plan.js";

interface ChannelDeliveryStartInstrumentation {
  readonly agentName?: string;
  readonly ctx: AlsContext;
  readonly delivery: DeliverHookPayload;
  readonly hooks?: InstrumentationHooks;
  readonly instrumentation?: SessionInstrumentation;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

interface ChannelDeliveryTerminalInstrumentation {
  readonly ctx: AlsContext;
  readonly error?: unknown;
  readonly errorCode?: string;
  readonly hooks?: InstrumentationHooks;
  readonly instrumentation?: SessionInstrumentation;
  readonly includeTurn: boolean;
  readonly outcome: InstrumentationChannelDeliveryOutcome;
}

export function instrumentChannelDelivery(
  input: ChannelDeliveryStartInstrumentation,
): Promise<void>;
export function instrumentChannelDelivery(
  input: ChannelDeliveryTerminalInstrumentation,
): Promise<void>;
export async function instrumentChannelDelivery(
  input: ChannelDeliveryStartInstrumentation | ChannelDeliveryTerminalInstrumentation,
): Promise<void> {
  const instrumentation = resolveInstrumentation(input);
  if (instrumentation === undefined) return;
  if (!("delivery" in input)) {
    const active = input.ctx.get(ActiveChannelDeliveriesKey);
    if (active === undefined) return;
    const type =
      `channel.delivery.${input.outcome}` as InstrumentationChannelDeliveryTerminalEvent["type"];
    for (const item of active) {
      await instrumentation.publish({
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

  if (input.delivery.deliveryMetadata === undefined) return;

  const active: ActiveChannelDelivery[] = [];
  for (const metadata of input.delivery.deliveryMetadata) {
    const payload = input.delivery.payloads[metadata.payloadIndex];
    const delivery = {
      channelKind: metadata.channelKind,
      channelName: metadata.channelName,
      deliveryId: metadata.deliveryId,
      requestId: metadata.requestId,
      requestTraceContext: metadata.requestTraceContext,
    };
    const deliveryInput =
      !instrumentation.hooks.capturesContent || payload === undefined
        ? undefined
        : projectDeliveryInput(payload);
    const item: ActiveChannelDelivery = {
      agentName: input.agentName,
      delivery,
      rootSessionId: input.rootSessionId,
      sequence: input.sequence,
      sessionId: input.sessionId,
      turnId: input.turnId,
    };
    active.push(item);
    await instrumentation.publish({
      agentName: item.agentName,
      delivery,
      idempotencyKey: channelDeliveryIdempotencyKey(input.sessionId, delivery.deliveryId),
      input: deliveryInput,
      rootSessionId: input.rootSessionId,
      sessionId: input.sessionId,
      type: "channel.delivery.started",
    });
  }
  if (active.length > 0) input.ctx.set(ActiveChannelDeliveriesKey, active);
}

function resolveInstrumentation(
  input: ChannelDeliveryStartInstrumentation | ChannelDeliveryTerminalInstrumentation,
): Pick<SessionInstrumentation, "hooks" | "publish"> | undefined {
  if (input.instrumentation !== undefined) return input.instrumentation;
  if (input.hooks === undefined) return undefined;
  return { hooks: input.hooks, publish: (event) => input.hooks!.publish(event) };
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

export function channelDeliveryErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { readonly code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "CHANNEL_DELIVERY_FAILED";
}
