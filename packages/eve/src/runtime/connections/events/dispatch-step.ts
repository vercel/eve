import { createLogger } from "#internal/logging.js";
import { connectionEventAttributes } from "#tracing/eve/connection-events.js";
import { sessionStartedForResolvers } from "#harness/session-machine/resolver-events.js";
import { resolveDynamicConnectionResult } from "#runtime/resolve-dynamic-connection.js";
import { deserializeContext } from "#context/serialize.js";
import { AuthKey } from "#context/keys.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createAttachSessionFn } from "#channel/session.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import {
  retireConnectionEventOwner,
  findConnectionEventOwner,
} from "#runtime/connections/events/owner.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import {
  principalKey,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import type { AlsContext } from "#context/container.js";

/** Re-checks the run's saved binding against the deployed connection before any work runs as its creator. */
export async function resolveBinding(ctx: AlsContext, binding: EventBinding) {
  const agent = ctx.require(BundleKey).resolvedAgent;
  const saved = binding.resolution;
  const resolver =
    saved === undefined
      ? undefined
      : agent.dynamicConnectionResolvers?.find(
          (candidate) => candidate.sourceId === saved.sourceId && candidate.slug === saved.slug,
        );
  const connections =
    saved === undefined
      ? agent.connections
      : resolver === undefined
        ? []
        : await withConnectionEventSpan(
            {
              ctx,
              connectionName: binding.connectionName,
              bindingId: binding.id,
              operation: "resolve",
            },
            () =>
              resolveDynamicConnectionResult({
                resolver,
                context: structuredClone(saved.context),
                event: sessionStartedForResolvers(saved.runtime),
                nodeId: ctx.require(BundleKey).nodeId,
              }),
          );
  const connection = connections.find(
    (candidate) => candidate.connectionName === binding.connectionName,
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
  const watch = await findConnectionEventOwner(input.binding.id);
  if (watch === undefined || watch.stopping || watch.subscription?.id !== delivery.subscriptionId)
    return;
  if (!accepts(input.binding, input.payload)) return;
  const resolved = await resolveBinding(ctx, input.binding);
  if (resolved === undefined) {
    if (input.binding.resolution !== undefined) {
      createLogger("connection.events").info(
        "Dynamic event watch no longer resolves to its saved account.",
        {
          ...connectionEventAttributes({
            connectionName: input.binding.connectionName,
            bindingId: input.binding.id,
            subscriptionId: delivery.subscriptionId,
          }),
          reason: "binding_unavailable",
        },
      );
      await retireConnectionEventOwner(input.binding.id, watch.runId);
    }
    return;
  }
  // Account resolution can outlast a concurrent stop or completed cleanup.
  const current = await findConnectionEventOwner(input.binding.id);
  if (
    current === undefined ||
    current.stopping ||
    current.runId !== watch.runId ||
    current.subscription?.id !== delivery.subscriptionId
  )
    return;
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
    await retireConnectionEventOwner(binding.id, watch.runId);
}
