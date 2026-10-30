import { deserializeContext } from "#context/serialize.js";
import { AuthKey } from "#context/keys.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createAttachSessionFn } from "#channel/session.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import { retireConnectionEventOwner } from "#runtime/connections/events/owner.js";
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

/** The hook token already routed this delivery to its binding; its content must still match. */
function accepts(binding: EventBinding, payload: ConnectionEventPayload): boolean {
  const { delivery } = payload;
  return (
    payload.connectionName === binding.connectionName &&
    !("event" in delivery && delivery.event.name !== binding.request.name)
  );
}

/**
 * Runs one delivery's callback as the watch's creator. A crash before the
 * step completes re-runs the callback, so callbacks are idempotent on
 * deliveryId. A `terminated` delivery then retires the watch.
 */
export async function dispatchConnectionEventStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly binding: EventBinding;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const { delivery } = input.payload;
  // The receiver or the watch's run already matched the delivery's subscription.
  const resolved = accepts(input.binding, input.payload)
    ? resolveBinding(ctx, input.binding)
    : undefined;
  if (resolved === undefined) return;
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
  if ("control" in delivery && delivery.control.type === "terminated")
    await retireConnectionEventOwner(binding.id);
}
