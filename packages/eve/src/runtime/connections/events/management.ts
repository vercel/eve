import { getSubscription } from "#compiled/@vercel/connect-events/index.js";
import { loadContext, type AlsContext } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { principalOf } from "#execution/session/principal.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import type { EventBinding } from "#runtime/connections/events/state.js";
import { parseJsonObject } from "#shared/json.js";
import { withConnectionEventSpan } from "#tracing/eve/connection-events.js";

export async function manageSavedWatch(input: {
  readonly ctx: AlsContext;
  readonly id: string;
  readonly operation: "get" | "stop";
  readonly authorize: (binding: EventBinding) => boolean;
  readonly getSubscription: (binding: EventBinding, id: string) => Promise<{ readonly id: string }>;
}): Promise<unknown> {
  const { findConnectionEventOwner, retireConnectionEventOwner } = await import("./owner.js");
  const watch = await findConnectionEventOwner(input.id);
  if (watch === undefined || !input.authorize(watch.owner))
    throw new Error("Unknown subscription for this caller and account.");
  if (input.operation === "stop") {
    if (!(await retireConnectionEventOwner(input.id, watch.runId)))
      throw new Error("Unknown subscription for this caller and account.");
    return { id: input.id, status: "stopping" };
  }
  if (watch.stopping) return { id: input.id, status: "stopping", cleanupStatus: "pending" };
  const subscription = watch.subscription;
  if (subscription === undefined) return pendingResult(watch.owner);
  const result = await withConnectionEventSpan(
    {
      ctx: input.ctx,
      connectionName: watch.owner.connectionName,
      bindingId: input.id,
      subscriptionId: subscription.id,
      operation: "get",
    },
    () => input.getSubscription(watch.owner, subscription.id),
  );
  return subscriptionResult(input.id, result);
}

/** Explicitly opted-in housekeeping, independent of the current connection's policies. */
export async function manageCreatorWatch(operation: "get" | "stop", input: unknown) {
  const { id } = parseJsonObject(input);
  if (typeof id !== "string") throw new Error("id must be a subscription id.");
  const ctx = loadContext();
  return manageSavedWatch({
    ctx,
    id,
    operation,
    authorize: (owner) =>
      ctx.require(BundleKey).nodeId === undefined &&
      owner.creatorManagement === true &&
      owner.executionPrincipal === principalOf(ctx.get(AuthKey)),
    getSubscription: (owner, subscriptionId) =>
      getSubscription(owner.connector, { id: subscriptionId }, { timeout: 30_000 }),
  });
}

/** Model-facing ids locate eve's watch rather than the upstream subscription. */
export function subscriptionResult<T extends { readonly id: string }>(
  bindingId: string,
  subscription: T,
) {
  return { ...subscription, id: bindingId, subscriptionId: subscription.id };
}

/** A pending subscribe already has an id that get and stop can use. */
export function pendingResult(binding: EventBinding) {
  const { name, arguments: eventArguments } = binding.request;
  return { id: binding.id, name, arguments: eventArguments, status: "pending" as const };
}
