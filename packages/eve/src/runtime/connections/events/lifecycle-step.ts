import { startedApp } from "#runtime/app.js";
import { bindApp } from "#context/app.js";
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

export async function subscribeConnectionEvent(
  serializedContext: Record<string, unknown>,
  binding: EventBinding,
  idempotencyKey: string,
): Promise<ConnectionEventSubscribeResult> {
  const ctx = await deserializeContext(serializedContext);
  bindApp(ctx, startedApp());
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
    return { subscription: structuredClone(subscription) };
  } catch (error) {
    const status = readHttpStatus(error);
    if (status === undefined || !isRefusal(status)) throw error;
    return { error: error instanceof Error ? error.message : String(error), status };
  }
}

export async function unsubscribeConnectionEventStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly binding: EventBinding;
  readonly subscriptionId: string;
}): Promise<"pending" | "done"> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  bindApp(ctx, startedApp());
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

function isRefusal(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

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
