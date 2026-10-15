import { principalOf } from "#execution/session/principal.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
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
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import { connectionEventStore } from "#runtime/connections/events/store.js";
import type { AlsContext } from "#context/container.js";

function resolveBinding(ctx: AlsContext, payload: ConnectionEventPayload, binding: EventBinding) {
  const connection = ctx
    .require(BundleKey)
    .resolvedAgent.connections.find(
      (connection) => connection.connectionName === payload.connectionName,
    );
  if (
    binding.id !== payload.bindingId ||
    connection?.experimental_events === undefined ||
    binding.sessionId !== ctx.require(SessionIdKey) ||
    binding.connectionName !== payload.connectionName ||
    binding.instanceId !== connection.instanceId ||
    binding.executionPrincipal !== principalOf(binding.auth)
  )
    return undefined;
  const authorization = connection.authorization;
  if (
    authorization === undefined ||
    typeof authorization === "function" ||
    authorization.vercelConnect?.connector !== binding.connector ||
    authorization.vercelConnect.experimental_events === undefined
  )
    return undefined;
  const principal = resolveConnectionPrincipalFromAuth(
    connection.connectionName,
    authorization,
    binding.auth,
  );
  if (principalKey(principal) !== binding.principalKey) return undefined;
  return {
    binding,
    connection,
    principal,
    backend: authorization.vercelConnect.experimental_events,
  };
}

export async function prepareConnectionEventStep(input: {
  serializedContext: Record<string, unknown>;
  state: ConnectionEventHandlerState;
  payload: ConnectionEventPayload;
}) {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const resolved = resolveBinding(ctx, input.payload, input.state.binding);
  const result = (accepted: boolean, state = input.state) => ({
    accepted,
    state,
    serializedContext: serializeContext(ctx),
  });
  if (resolved === undefined) return result(false);
  const { connection, principal, backend } = resolved;
  const state = input.state;
  let { binding } = resolved;
  const { delivery } = input.payload;
  const receipt = state.receipts[delivery.deliveryId];
  const store = connectionEventStore(connection, binding);
  const current = (await store.list())[binding.id];
  if (current === undefined || resolveBinding(ctx, input.payload, current) === undefined)
    return result(false);
  binding = current;
  const resumingTermination =
    "control" in delivery &&
    delivery.control.type === "terminated" &&
    binding.terminationDeliveryId === delivery.deliveryId;
  if (receipt === "complete" || (binding.retired && receipt !== "pending" && !resumingTermination))
    return result(false);
  // A timeout may have hidden Connect's successful subscribe response. Reconcile
  // the saved intent with its original idempotency key before trusting the ID.
  if (binding.subscription === undefined) {
    const request = binding.request;
    const subscription = await withConnectionEventSpan(
      {
        ctx,
        connectionName: connection.connectionName,
        operation: "recover",
        bindingId: binding.id,
        requestTraceContext: input.payload.requestTraceContext,
        deliveryId: delivery.deliveryId,
      },
      async () => {
        const adapter = await backend.createAdapter({
          principal,
          connection: { url: connection.url },
          destination: { path: connectionEventDestination(connection.connectionName) },
        });
        return adapter.subscribe({ ...request, options: { timeout: 30_000 } });
      },
    );
    binding = { ...binding, subscription };
  }
  if (
    binding.subscription!.id !== delivery.subscriptionId ||
    ("event" in delivery && delivery.event.name !== binding.request.name)
  )
    return result(false);
  if (
    "event" in delivery &&
    ["stopped", "expired", "failed"].includes(binding.subscription!.status)
  )
    return result(false);
  let next: EventBinding =
    "control" in delivery && delivery.control.type === "terminated"
      ? { ...binding, retired: true, terminationDeliveryId: delivery.deliveryId }
      : binding;
  if ("control" in delivery && delivery.control.type === "gap")
    next = { ...next, gap: { cursor: delivery.control.cursor, deliveryId: delivery.deliveryId } };
  next = await store.save(next);
  if (
    next.retired &&
    receipt !== "pending" &&
    !("control" in delivery && delivery.control.type === "terminated")
  )
    return result(false);
  return result(true, {
    binding: next,
    receipts: { ...state.receipts, [delivery.deliveryId]: "pending" },
  });
}

export async function dispatchConnectionEventStep(input: {
  serializedContext: Record<string, unknown>;
  state: ConnectionEventHandlerState;
  payload: ConnectionEventPayload;
}) {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const resolved = resolveBinding(ctx, input.payload, input.state.binding);
  if (resolved === undefined)
    return { serializedContext: input.serializedContext, state: input.state };
  const { binding, connection } = resolved;
  const state = input.state;
  const { delivery } = input.payload;
  if (
    state.receipts[delivery.deliveryId] !== "pending" ||
    binding.subscription?.id !== delivery.subscriptionId
  )
    return { serializedContext: input.serializedContext, state };
  const bundle = ctx.require(BundleKey);
  const callbacks = connection.experimental_events!;
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
  // Bound checkpoint size; durable external effects still use deliveryId as
  // their idempotency key when Connect redelivers beyond this recent window.
  const completed = Object.entries(state.receipts)
    .filter(([id, status]) => status === "complete" && id !== delivery.deliveryId)
    .slice(-999);
  const pending = Object.entries(state.receipts).filter(
    ([id, status]) => status === "pending" && id !== delivery.deliveryId,
  );
  const next: ConnectionEventHandlerState = {
    ...state,
    receipts: {
      ...Object.fromEntries([...completed, ...pending]),
      [delivery.deliveryId]: "complete",
    },
  };
  return { serializedContext: serializeContext(ctx), state: next };
}
