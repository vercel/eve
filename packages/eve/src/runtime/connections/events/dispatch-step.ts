import { principalOf } from "#execution/session/principal.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import { AuthKey, SessionIdKey } from "#context/keys.js";
import { contextStorage } from "#context/container.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { createAttachSessionFn } from "#channel/session.js";
import type { SessionStepState } from "#execution/publish-session-events.js";
import { withSessionStateDelta } from "#execution/session/state-delta.js";
import { ConnectionEventsStateKey, type EventBinding } from "#runtime/connections/events/state.js";
import type { ConnectionEventInboxPayload } from "#runtime/connections/events/delivery.js";
import {
  principalKey,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import type { AlsContext } from "#context/container.js";

function resolveBinding(ctx: AlsContext, payload: ConnectionEventInboxPayload) {
  const state = ctx.get(ConnectionEventsStateKey);
  const binding = state?.bindings[payload.bindingId];
  const connection = ctx
    .require(BundleKey)
    .resolvedAgent.connections.find(
      (connection) => connection.connectionName === payload.connectionName,
    );
  if (
    binding === undefined ||
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
    state: state!,
    binding,
    connection,
    principal,
    backend: authorization.vercelConnect.experimental_events,
  };
}

export async function prepareConnectionEventStep(
  input: SessionStepState & { payload: ConnectionEventInboxPayload },
) {
  "use step";
  return withSessionStateDelta(input, async () => {
    const ctx = await deserializeContext(input.serializedContext);
    const resolved = resolveBinding(ctx, input.payload);
    const result = (accepted: boolean) => ({ accepted, serializedContext: serializeContext(ctx) });
    if (resolved === undefined) return result(false);
    const { state, connection, principal, backend } = resolved;
    let { binding } = resolved;
    const { delivery } = input.payload;
    const receipt = state.receipts[delivery.deliveryId];
    if (receipt === "complete" || (binding.retired && receipt !== "pending")) return result(false);
    // A timeout may have hidden Connect's successful subscribe response. Reconcile
    // the saved intent with its original idempotency key before trusting the ID.
    if (binding.subscription === undefined) {
      const adapter = await backend.createAdapter({
        principal,
        connection: { url: connection.url },
        destination: { path: connectionEventDestination(connection.connectionName) },
      });
      const subscription = await adapter.subscribe({
        ...binding.request,
        options: { timeout: 30_000 },
      });
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
        ? { ...binding, retired: true }
        : binding;
    if ("control" in delivery && delivery.control.type === "gap")
      next = { ...next, gap: { cursor: delivery.control.cursor, deliveryId: delivery.deliveryId } };
    ctx.set(ConnectionEventsStateKey, {
      bindings: { ...state.bindings, [binding.id]: next },
      receipts: { ...state.receipts, [delivery.deliveryId]: "pending" },
    });
    return result(true);
  });
}

export async function dispatchConnectionEventStep(
  input: SessionStepState & { payload: ConnectionEventInboxPayload },
) {
  "use step";
  return withSessionStateDelta(input, async () => {
    const ctx = await deserializeContext(input.serializedContext);
    const resolved = resolveBinding(ctx, input.payload);
    if (resolved === undefined) return { serializedContext: input.serializedContext };
    const { binding, connection, state } = resolved;
    const { delivery } = input.payload;
    if (
      state.receipts[delivery.deliveryId] !== "pending" ||
      binding.subscription?.id !== delivery.subscriptionId
    )
      return { serializedContext: input.serializedContext };
    const bundle = ctx.require(BundleKey);
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
        { turnPolicy: "queue" },
      ),
    };
    const callbacks = connection.experimental_events!;
    // The callback runs as its creator without replacing the last conversational caller.
    ctx.setVirtualContext(AuthKey, binding.auth);
    await contextStorage.run(ctx, async () => {
      if ("event" in delivery) await callbacks.onEvent({ ...common, event: delivery.event });
      else if (delivery.control.type === "gap")
        await callbacks.onGap?.({
          ...common,
          cursor: delivery.control.cursor,
          truncated: delivery.control.truncated,
        });
      else await callbacks.onTerminated?.({ ...common, error: delivery.control.error });
    });
    // Bound checkpoint size; durable external effects still use deliveryId as
    // their idempotency key when Connect redelivers beyond this recent window.
    const completed = Object.entries(state.receipts)
      .filter(([id, status]) => status === "complete" && id !== delivery.deliveryId)
      .slice(-999);
    const pending = Object.entries(state.receipts).filter(
      ([id, status]) => status === "pending" && id !== delivery.deliveryId,
    );
    ctx.set(ConnectionEventsStateKey, {
      ...state,
      receipts: {
        ...Object.fromEntries([...completed, ...pending]),
        [delivery.deliveryId]: "complete",
      },
    });
    return { serializedContext: serializeContext(ctx) };
  });
}
