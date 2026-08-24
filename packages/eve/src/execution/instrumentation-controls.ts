import { getAdapterKind, type ChannelAdapter } from "#channel/adapter.js";
import type { DeliverHookPayload, DeliverPayload } from "#channel/types.js";
import type { ContextContainer } from "#context/container.js";
import { ChannelInstrumentationKey, InstrumentationControlsKey } from "#context/keys.js";
import {
  constructInstrumentation,
  getInstrumentationRuntime,
  type ConstructedInstrumentation,
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
  readonly scope: ConstructedInstrumentation;
}

const UNINSTRUMENTED: ConstructedInstrumentation = {
  run: (execute) => execute(),
};

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
  if (instrumentation === undefined) {
    return { channel: projectedChannel, scope: UNINSTRUMENTED };
  }

  const existing = input.ctx.get(InstrumentationControlsKey);
  const shouldResolve = existing === undefined || input.delivery?.kind === "deliver";
  const resolved = shouldResolve
    ? instrumentation.resolveDecision({
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
    scope: constructInstrumentation(instrumentation, controls),
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

/** Constructs the active delivery capability from a persisted decision. */
export function constructExecutionInstrumentation(
  controls: InstrumentationControls | undefined,
  instrumentation: InstrumentationRuntime | undefined,
): ConstructedInstrumentation {
  return controls === undefined || instrumentation === undefined
    ? UNINSTRUMENTED
    : constructInstrumentation(instrumentation, controls);
}

/** Constructs an out-of-band execution capability from serialized state. */
export function constructSerializedInstrumentation(
  serializedContext: Record<string, unknown>,
): ConstructedInstrumentation {
  const value = serializedContext[InstrumentationControlsKey.name];
  const controls =
    typeof value === "object" && value !== null && "action" in value
      ? (value as InstrumentationControls)
      : undefined;
  return constructExecutionInstrumentation(controls, getInstrumentationRuntime());
}
