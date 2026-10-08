import { deserializeContext } from "#context/serialize.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { ConnectionEventsStateKey } from "#runtime/connections/events/state.js";
import {
  principalKey,
  resolveConnectionPrincipalFromAuth,
} from "#runtime/connections/principal.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";

/** Cancellation retries durably; each Connect unsubscribe is idempotent. */
export async function stopConnectionEventStep(input: {
  serializedContext: Record<string, unknown>;
  bindingId: string;
}): Promise<void> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const state = ctx.get(ConnectionEventsStateKey);
  if (state === undefined) return;
  const bundle = ctx.require(BundleKey);
  const binding = state.bindings[input.bindingId];
  if (binding === undefined) return;
  const connection = bundle.resolvedAgent.connections.find(
    (connection) =>
      connection.connectionName === binding.connectionName &&
      connection.instanceId === binding.instanceId,
  );
  const authorization = connection?.authorization;
  if (
    connection === undefined ||
    authorization === undefined ||
    typeof authorization === "function" ||
    authorization.vercelConnect?.connector !== binding.connector ||
    authorization.vercelConnect.experimental_events === undefined
  )
    throw new Error("Cannot resolve the event subscription provider for session cleanup.");
  const principal = resolveConnectionPrincipalFromAuth(
    connection.connectionName,
    authorization,
    binding.auth,
  );
  if (principalKey(principal) !== binding.principalKey)
    throw new Error("Event subscription principal changed before cleanup.");
  const adapter = await authorization.vercelConnect.experimental_events.createAdapter({
    principal,
    connection: { url: connection.url },
    destination: { path: connectionEventDestination(connection.connectionName) },
  });
  // Resolve an uncertain creation with the original key before cancellation.
  const subscription =
    binding.subscription ??
    (await adapter.subscribe({ ...binding.request, options: { timeout: 30_000 } }));
  await adapter.unsubscribe({ id: subscription.id, options: { timeout: 30_000 } });
}
