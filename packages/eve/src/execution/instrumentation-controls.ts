import { getAdapterKind, type ChannelAdapter } from "#channel/adapter.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, InstrumentationControlsKey } from "#context/keys.js";
import {
  bindInstrumentationRuntime,
  getInstrumentationRuntime,
  type HarnessInstrumentation,
  type InstrumentationRuntime,
} from "#harness/instrumentation/runtime.js";
import { normalizeChannelAudience, withoutChannelAudience } from "#shared/channel-audience.js";
import { intersectInstrumentationControls } from "#shared/instrumentation-controls.js";
import type { InstrumentationControls } from "#shared/instrumentation-controls.js";

interface PreparedDeliveryInstrumentation {
  readonly channel?: {
    readonly kind?: string;
    readonly metadata: Readonly<Record<string, unknown>>;
  };
  readonly instrumentation?: HarnessInstrumentation;
}

/** Resolves one delivery's audience at the execution boundary and returns bound controls. */
export function prepareDeliveryInstrumentation(input: {
  readonly adapter: ChannelAdapter;
  readonly agentName?: string;
  readonly ctx: ContextContainer;
  readonly delivery?: { readonly deliveryMetadata?: unknown; readonly kind: string };
  readonly instrumentation?: InstrumentationRuntime;
  readonly rootSessionId: string;
  readonly sessionId: string;
}): PreparedDeliveryInstrumentation {
  const channel = input.ctx.get(ChannelInstrumentationKey);
  const projectedChannel =
    channel === undefined
      ? undefined
      : {
          kind: channel.kind,
          metadata: withoutChannelAudience(channel.metadata),
        };
  const { instrumentation } = input;
  if (instrumentation === undefined) return { channel: projectedChannel };

  const existing = input.ctx.get(InstrumentationControlsKey);
  const shouldResolve = existing === undefined || input.delivery?.kind === "deliver";
  const resolved = shouldResolve
    ? instrumentation.resolveControls({
        agentName: input.agentName,
        audience: normalizeChannelAudience(channel?.metadata.audience),
        rootSessionId: input.rootSessionId,
        sessionId: input.sessionId,
      })
    : existing;
  const controls =
    existing !== undefined && getAdapterKind(input.adapter) === "subagent"
      ? intersectInstrumentationControls(existing, resolved)
      : resolved;
  input.ctx.set(InstrumentationControlsKey, controls);
  return {
    channel: projectedChannel,
    instrumentation: bindInstrumentationRuntime(instrumentation, controls),
  };
}

/** Consumes controls ferried to a local child before its adapter sees the payload. */
export function consumeDeliveryInstrumentationControls(
  ctx: ContextContainer,
  delivery: DeliverHookPayload,
): DeliverHookPayload {
  let inherited: InstrumentationControls | undefined;
  let changed = false;
  const payloads = delivery.payloads.map((payload): DeliverPayload => {
    const controls = payload.instrumentationControls;
    if (controls === undefined) return payload;
    inherited =
      inherited === undefined ? controls : intersectInstrumentationControls(inherited, controls);
    changed = true;
    const { instrumentationControls: _controls, ...visible } = payload;
    return visible;
  });
  if (inherited !== undefined) ctx.set(InstrumentationControlsKey, inherited);
  return changed ? { ...delivery, payloads } : delivery;
}

/** Runs a dispatch side effect under the active delivery's drop decision. */
export function runWithInstrumentationControls<T>(
  controls: InstrumentationControls | undefined,
  instrumentation: InstrumentationRuntime | undefined,
  execute: () => PromiseLike<T>,
): PromiseLike<T> {
  return controls?.action === "drop" && instrumentation !== undefined
    ? instrumentation.runWithTracingSuppressed(execute)
    : execute();
}

/** Applies a serialized drop decision in out-of-band execution steps. */
export function runWithSerializedInstrumentationControls<T>(
  serializedContext: Record<string, unknown>,
  execute: () => PromiseLike<T>,
): PromiseLike<T> {
  const value = serializedContext[InstrumentationControlsKey.name];
  const dropped =
    typeof value === "object" &&
    value !== null &&
    (value as { action?: unknown }).action === "drop";
  const instrumentation = getInstrumentationRuntime();
  return dropped && instrumentation !== undefined
    ? instrumentation.runWithTracingSuppressed(execute)
    : execute();
}
