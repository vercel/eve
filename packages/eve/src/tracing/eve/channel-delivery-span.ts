import { otelTelemetry } from "#compiled/@vercel/agent-runs/index.js";
import { truncateTelemetryText } from "#compiled/@vercel/agent-runs/otel.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SessionIdKey } from "#context/keys.js";
import { getInstrumentationRuntime } from "#instrumentation/runtime-global.js";
import { createLogger } from "#internal/logging.js";
import { connectionEventTraceContext, sideSpanHost } from "#tracing/eve/connection-events.js";
import { eveOutputMapping } from "#tracing/eve/profile.js";

interface DeliveryAttempt {
  failure?: { readonly code: string; readonly errorId?: string };
}

const log = createLogger("channel.delivery");
const DeliveryAttemptKey = new ContextKey<DeliveryAttempt>("eve.channelDeliveryAttempt");

export function recordChannelDeliveryFailure(code: string, errorId?: string): void {
  const attempt = contextStorage.getStore()?.get(DeliveryAttemptKey);
  if (attempt !== undefined) attempt.failure ??= { code, errorId };
}

export async function withChannelDeliverySpan(
  input: {
    readonly adapterKind: string;
    readonly eventType: string;
    readonly reachesPerson: boolean;
    readonly turnId?: string;
  },
  execute: () => Promise<void>,
): Promise<void> {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return execute();
  const attempt: DeliveryAttempt = {};
  const startTimeMs = Date.now();
  ctx.setVirtualContext(DeliveryAttemptKey, attempt);
  try {
    await execute();
  } finally {
    ctx.delete(DeliveryAttemptKey);
  }
  if (!input.reachesPerson && attempt.failure === undefined) return;
  try {
    await recordDelivery(ctx, input, attempt, startTimeMs);
  } catch (error) {
    log.warn("recording a channel delivery span failed", { error });
  }
}

async function recordDelivery(
  ctx: AlsContext,
  input: { readonly adapterKind: string; readonly eventType: string; readonly turnId?: string },
  attempt: DeliveryAttempt,
  startTimeMs: number,
): Promise<void> {
  const sessionId = ctx.get(SessionIdKey);
  if (sessionId === undefined) return;
  const turnTrace =
    input.turnId === undefined
      ? undefined
      : await getInstrumentationRuntime()?.readTurnTraceContext?.(sessionId, input.turnId);
  const host = sideSpanHost(ctx, connectionEventTraceContext(turnTrace));
  if (host === undefined) return;
  const name = "agent.channel.deliver";
  const attributes: Record<string, string> = {
    "agent.channel.kind": truncateTelemetryText(input.adapterKind, 128),
    "agent.channel.event.type": input.eventType,
    "agent.channel.delivery.outcome": attempt.failure === undefined ? "completed" : "failed",
    "agent.run.id": truncateTelemetryText(sessionId, 256),
    "operation.name": name,
    "resource.name": name,
  };
  if (input.turnId !== undefined) attributes["agent.turn.id"] = input.turnId;
  if (attempt.failure?.errorId !== undefined) attributes["eve.error.id"] = attempt.failure.errorId;
  const span = otelTelemetry({ tracerName: "eve.channel", mapping: eveOutputMapping() }).startSpan(
    { type: "step", operationId: name, name, kind: "PRODUCER", attributes, startTimeMs },
    { context: host },
  );
  if (attempt.failure === undefined) span.setStatus("OK");
  else span.fail(undefined, attempt.failure.code);
  span.end();
}
