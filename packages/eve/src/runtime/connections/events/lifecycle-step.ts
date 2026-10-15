import { getWritable } from "#compiled/@workflow/core/index.js";
import { deserializeContext } from "#context/serialize.js";
import { readHttpStatus } from "#runtime/connections/mcp-client.js";
import { resolveBinding } from "#runtime/connections/events/dispatch-step.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import {
  CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  type ConnectionEventSubscribeOutcome,
  type ConnectionEventSubscribeResult,
  type EventBinding,
} from "#runtime/connections/events/state.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";

/**
 * Subscribes from inside the watch run, after its hook is registered, so a
 * delivery that beats the subscribe response finds the binding it runs under.
 */
export async function openConnectionEventStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly binding: EventBinding;
}): Promise<ConnectionEventSubscribeResult> {
  "use step";
  const outcome = await subscribeConnectionEvent(input.serializedContext, input.binding);
  await publishOutcome(outcome);
  return outcome;
}

/**
 * Connect's definitive refusals reach the model, and the run then ends
 * without a watch. Anything else, such as a timeout after Connect may have
 * created the subscription, throws so the step retries with the same
 * idempotency key.
 */
export async function subscribeConnectionEvent(
  serializedContext: Record<string, unknown>,
  binding: EventBinding,
): Promise<ConnectionEventSubscribeResult> {
  const ctx = await deserializeContext(serializedContext);
  const resolved = resolveBinding(ctx, binding);
  if (resolved === undefined)
    return { error: "This connection no longer accepts the subscription's binding." };
  const { connection, principal, events } = resolved;
  try {
    const subscription = await withConnectionEventSpan(
      {
        ctx,
        connectionName: connection.connectionName,
        bindingId: binding.id,
        operation: "subscribe",
      },
      async () => {
        const adapter = await events.backend.createAdapter({
          principal,
          connection: { url: connection.url },
          destination: { path: connectionEventDestination(connection.connectionName) },
        });
        return adapter.subscribe({ ...binding.request, options: { timeout: 30_000 } });
      },
    );
    // Snapshot the SDK's readonly JSON into the run's owned state.
    return { subscription: structuredClone(subscription) };
  } catch (error) {
    const status = readHttpStatus(error);
    if (status === undefined || !isRefusal(status)) throw error;
    return { error: error instanceof Error ? error.message : String(error), status };
  }
}

/** A 4xx other than a timeout or rate limit: retrying the same request can't succeed. */
function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Publishes, for a duplicate run's caller, the run that owns the watch.
 */
export async function publishConnectionEventOutcomeStep(
  outcome: ConnectionEventSubscribeOutcome,
): Promise<void> {
  "use step";
  await publishOutcome(outcome);
}

async function publishOutcome(outcome: ConnectionEventSubscribeOutcome): Promise<void> {
  const writer = getWritable<ConnectionEventSubscribeOutcome>({
    namespace: CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  }).getWriter();
  try {
    await writer.write(outcome);
  } finally {
    writer.releaseLock();
  }
}
