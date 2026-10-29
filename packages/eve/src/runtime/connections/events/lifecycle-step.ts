import { createHash } from "node:crypto";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { deserializeContext } from "#context/serialize.js";
import { readHttpStatus } from "#runtime/connections/mcp-client.js";
import { resolveBinding } from "#runtime/connections/events/dispatch-step.js";
import { startConnectionEventDeliveryRun } from "#runtime/connections/events/owner.js";
import { connectionEventDestination } from "#runtime/connections/events/path.js";
import {
  CONNECTION_EVENT_SUBSCRIPTION_NAMESPACE,
  type ConnectionEventSubscribeOutcome,
  type ConnectionEventSubscribeResult,
  type EventBinding,
} from "#runtime/connections/events/state.js";
import type { ConnectionEventPayload } from "#runtime/connections/events/delivery.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";

/**
 * Subscribes from inside the watch run, after its hook is registered, so a
 * delivery that beats the subscribe response finds the binding it runs under.
 * The key is the run's own: a retried step reuses it, and a later run for the
 * same watch, after this one ended, subscribes afresh.
 */
export async function openConnectionEventStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly binding: EventBinding;
}): Promise<ConnectionEventSubscribeResult> {
  "use step";
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify([input.binding.id, getWorkflowMetadata().workflowRunId]))
    .digest("hex");
  const outcome = await subscribeConnectionEvent(
    input.serializedContext,
    input.binding,
    idempotencyKey,
  );
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
  idempotencyKey: string,
): Promise<ConnectionEventSubscribeResult> {
  const ctx = await deserializeContext(serializedContext);
  const resolved = resolveBinding(ctx, binding);
  if (resolved === undefined)
    return { error: "This connection no longer accepts the subscription's binding." };
  const { connection } = resolved;
  try {
    const subscription = await withConnectionEventSpan(
      {
        ctx,
        connectionName: connection.connectionName,
        bindingId: binding.id,
        operation: "subscribe",
      },
      async () => {
        const adapter = await createAdapter(resolved);
        return adapter.subscribe({
          ...binding.request,
          idempotencyKey,
          options: { timeout: 30_000 },
        });
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

/**
 * One unsubscribe attempt for a stopped watch. "done" only once Connect has
 * finished cleanup or no longer has the subscription. Anything else, whether
 * Connect still cleaning up, an outage, refused credentials or a connection a
 * redeploy removed, is "pending": the watch keeps its hook and repeats the
 * attempt with its own durable backoff, so Workflow's step retries never
 * decide when cleanup gives up.
 */
export async function unsubscribeConnectionEventStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly binding: EventBinding;
  readonly subscriptionId: string;
}): Promise<"pending" | "done"> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  const resolved = resolveBinding(ctx, input.binding);
  if (resolved === undefined) return "pending";
  try {
    const subscription = await withConnectionEventSpan(
      {
        ctx,
        connectionName: resolved.connection.connectionName,
        bindingId: input.binding.id,
        subscriptionId: input.subscriptionId,
        operation: "unsubscribe",
      },
      async () =>
        (await createAdapter(resolved)).unsubscribe({
          id: input.subscriptionId,
          options: { timeout: 30_000 },
        }),
    );
    return subscription.cleanupStatus === "pending" ? "pending" : "done";
  } catch (error) {
    const status = readHttpStatus(error);
    return status === 404 || status === 410 ? "done" : "pending";
  }
}

/** Starts a delivery the watch's run took because it arrived before the subscribe response. */
export async function startConnectionEventDeliveryStep(input: {
  readonly binding: EventBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly payload: ConnectionEventPayload;
}): Promise<void> {
  "use step";
  await startConnectionEventDeliveryRun(input);
}

function createAdapter({
  connection,
  principal,
  events,
}: NonNullable<ReturnType<typeof resolveBinding>>) {
  return events.backend.createAdapter({
    principal,
    connection: { url: connection.url },
    destination: { path: connectionEventDestination(connection.connectionName) },
  });
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
