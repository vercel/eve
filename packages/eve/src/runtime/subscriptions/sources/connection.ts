import { createAttachSessionFn } from "#channel/session.js";
import type { AlsContext } from "#context/container.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import {
  principalKey,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import { readHttpStatus } from "#runtime/connections/mcp-client.js";
import { requireCompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { retireSubscriptionOwner } from "#runtime/subscriptions/owner.js";
import { connectionEventDestination } from "#runtime/subscriptions/path.js";
import {
  type ConnectionSubscriptionSource,
  type SubscriptionBinding,
} from "#runtime/subscriptions/state.js";
import type { SubscriptionSourceRuntime } from "#runtime/subscriptions/sources/types.js";
import type { ConnectionEventDelivery } from "#shared/connection-events.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";

function connectionOf(binding: SubscriptionBinding): ConnectionSubscriptionSource {
  if (binding.source.kind !== "connection")
    throw new Error(`Expected a connection subscription, got "${binding.source.kind}".`);
  return binding.source;
}

export function resolveConnectionBinding(ctx: AlsContext, binding: SubscriptionBinding) {
  const source = connectionOf(binding);
  const connection = requireCompiledBundle(ctx).resolvedAgent.connections.find(
    (candidate) => candidate.connectionName === source.name,
  );
  const events = connection?.experimental_events;
  if (
    connection === undefined ||
    events === undefined ||
    source.instanceId !== connection.instanceId ||
    events.connector !== source.connector
  )
    return undefined;
  const principal = resolveConnectionPrincipalFromAuth(
    source.name,
    events.authorization,
    binding.auth,
  );
  if (principalKey(principal) !== source.principalKey) return undefined;
  return { binding, source, connection, events, principal };
}

function createAdapter({
  connection,
  principal,
  events,
}: NonNullable<ReturnType<typeof resolveConnectionBinding>>) {
  return events.backend.createAdapter({
    principal,
    connection: { url: connection.url },
    destination: { path: connectionEventDestination(connection.connectionName) },
  });
}

function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

export const connectionSource: SubscriptionSourceRuntime = {
  async open({ ctx, binding, idempotencyKey }) {
    const resolved = resolveConnectionBinding(ctx, binding);
    if (resolved === undefined)
      return { error: "This connection no longer accepts the subscription's binding." };
    const { connection, source } = resolved;
    try {
      const subscription = await withConnectionEventSpan(
        {
          ctx,
          connectionName: connection.connectionName,
          bindingId: binding.id,
          operation: "subscribe",
        },
        async () =>
          (await createAdapter(resolved)).subscribe({
            ...source.request,
            idempotencyKey,
            options: { timeout: 30_000 },
          }),
      );
      return {
        opened: {
          key: subscription.id,
          expiresAt: subscription.expiresAt,
          upstream: structuredClone(subscription),
        },
      };
    } catch (error) {
      const status = readHttpStatus(error);
      if (status === undefined || !isRefusal(status)) throw error;
      return { error: error instanceof Error ? error.message : String(error), status };
    }
  },

  async close({ ctx, binding, opened }) {
    const resolved = resolveConnectionBinding(ctx, binding);
    if (resolved === undefined) return "pending";
    try {
      const subscription = await withConnectionEventSpan(
        {
          ctx,
          connectionName: resolved.connection.connectionName,
          bindingId: binding.id,
          subscriptionId: opened.key,
          operation: "unsubscribe",
        },
        async () =>
          (await createAdapter(resolved)).unsubscribe({
            id: opened.key,
            options: { timeout: 30_000 },
          }),
      );
      return subscription.cleanupStatus === "pending" ? "pending" : "done";
    } catch (error) {
      const status = readHttpStatus(error);
      return status === 404 || status === 410 ? "done" : "pending";
    }
  },

  async deliver({ ctx, binding, event }) {
    const delivery = event.data as unknown as ConnectionEventDelivery;
    const resolved = resolveConnectionBinding(ctx, binding);
    if (resolved === undefined) return;
    const { source, connection } = resolved;
    if ("event" in delivery && delivery.event.name !== source.request.name) return;
    const bundle = requireCompiledBundle(ctx);
    const { callbacks } = resolved.events;
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
        requestTraceContext: event.requestTraceContext,
      },
      async (reference) => {
        const common = {
          auth: binding.auth,
          deliveryId: delivery.deliveryId,
          origin: {
            sessionId: binding.sessionId,
            connectionName: source.name,
            subscriptionId: delivery.subscriptionId,
          },
          attachSession: createAttachSessionFn(
            createWorkflowRuntime({ compiledArtifactsSource: bundle.compiledArtifactsSource }),
            {
              turnPolicy: "queue",
              channelKind: "mcp-events",
              channelName: source.name,
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
      await retireSubscriptionOwner(binding.id);
  },
};
