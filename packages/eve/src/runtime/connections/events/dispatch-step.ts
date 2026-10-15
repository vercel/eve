import { deserializeContext, serializeContext } from "#context/serialize.js";
import { AuthKey } from "#context/keys.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createAttachSessionFn } from "#channel/session.js";
import type {
  ConnectionEventHandlerState,
  EventBinding,
} from "#runtime/connections/events/state.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import {
  principalKey,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import type { AlsContext } from "#context/container.js";

/** Re-checks the run's saved binding against the deployed connection before any work runs as its creator. */
export function resolveBinding(ctx: AlsContext, binding: EventBinding) {
  const connection = ctx
    .require(BundleKey)
    .resolvedAgent.connections.find(
      (connection) => connection.connectionName === binding.connectionName,
    );
  const events = connection?.experimental_events;
  if (
    connection === undefined ||
    events === undefined ||
    binding.instanceId !== connection.instanceId ||
    events.connector !== binding.connector
  )
    return undefined;
  const principal = resolveConnectionPrincipalFromAuth(
    binding.connectionName,
    events.authorization,
    binding.auth,
  );
  if (principalKey(principal) !== binding.principalKey) return undefined;
  return { binding, connection, events, principal };
}

/** The hook token already routed this delivery to its binding; the subscription decides acceptance. */
function accepts(state: ConnectionEventHandlerState, payload: ConnectionEventPayload): boolean {
  const { delivery } = payload;
  return (
    payload.connectionName === state.binding.connectionName &&
    delivery.subscriptionId === state.subscription.id &&
    !("event" in delivery && delivery.event.name !== state.binding.request.name)
  );
}

/** Bounds the run's checkpoint; durable external effects still key on deliveryId past this window. */
const RECEIPT_WINDOW = 1000;

/**
 * Runs one delivery's callback as the watch's creator, unless the run already
 * completed it. A crash before the receipt is recorded re-runs the callback,
 * so callbacks are idempotent on deliveryId.
 */
export async function dispatchConnectionEventStep(input: {
  serializedContext: Record<string, unknown>;
  state: ConnectionEventHandlerState;
  payload: ConnectionEventPayload;
}) {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const { state } = input;
  const { delivery } = input.payload;
  const resolved =
    accepts(state, input.payload) && !state.receipts.includes(delivery.deliveryId)
      ? resolveBinding(ctx, state.binding)
      : undefined;
  if (resolved === undefined)
    return { accepted: false, serializedContext: input.serializedContext, state };
  const { binding, connection } = resolved;
  const bundle = ctx.require(BundleKey);
  const { callbacks } = resolved.events;
  // The callback runs as its creator without replacing the last conversational caller.
  ctx.setVirtualContext(AuthKey, binding.auth);
  const operation =
    "event" in delivery ? "onEvent" : delivery.control.type === "gap" ? "onGap" : "onTerminated";
  await withConnectionEventSpan(
    {
      ctx,
      connectionName: connection.connectionName,
      operation,
      bindingId: binding.id,
      subscriptionId: delivery.subscriptionId,
      deliveryId: delivery.deliveryId,
      requestTraceContext: input.payload.requestTraceContext,
    },
    async (reference) => {
      const common = {
        auth: binding.auth,
        deliveryId: delivery.deliveryId,
        origin: {
          sessionId: binding.sessionId,
          connectionName: binding.connectionName,
          subscriptionId: delivery.subscriptionId,
        },
        attachSession: createAttachSessionFn(
          createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
          {
            turnPolicy: "queue",
            channelKind: "mcp-events",
            channelName: binding.connectionName,
            requestId: delivery.deliveryId,
            requestTraceContext: reference,
          },
        ),
      };
      if ("event" in delivery) await callbacks.onEvent({ ...common, event: delivery.event });
      else if (delivery.control.type === "gap")
        await callbacks.onGap?.({
          ...common,
          cursor: delivery.control.cursor,
          truncated: delivery.control.truncated,
        });
      else await callbacks.onTerminated?.({ ...common, error: delivery.control.error });
    },
  );
  const next: ConnectionEventHandlerState = {
    ...state,
    receipts: [...state.receipts, delivery.deliveryId].slice(-RECEIPT_WINDOW),
  };
  return { accepted: true, serializedContext: serializeContext(ctx), state: next };
}
