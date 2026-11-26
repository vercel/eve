import { randomUUID } from "node:crypto";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { contextStorage } from "#context/container.js";
import { AuthKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import {
  subscriptionDeliveryWorkflowReference,
  subscriptionKeyWorkflowReference,
} from "#execution/workflow-references.js";
import {
  startWorkflowOnCurrentDeployment,
  startWorkflowOnDeployment,
} from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import { resolveDurableCompiledArtifactsSource } from "#runtime/durable-compiled-artifacts-source.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { resumeKey, resumeOwner } from "#runtime/subscriptions/hooks.js";
import { openIdempotencyKey } from "#runtime/subscriptions/keys.js";
import { bindingContext } from "#runtime/subscriptions/owner.js";
import { readFirstPublished } from "#runtime/subscriptions/published-outcome.js";
import { subscriptionSource } from "#runtime/subscriptions/sources/index.js";
import {
  joinAckNamespace,
  SESSION_KEY_SOURCE,
  SUBSCRIPTION_OUTCOME_NAMESPACE,
  type JoinAck,
  type OpenedSubscription,
  type OpenOutcome,
  type SubscriptionBinding,
  type SubscriptionEvent,
  type SubscriptionKeySource,
  type SubscriptionOutcome,
} from "#runtime/subscriptions/state.js";

const log = createLogger("runtime.subscriptions");

const MAX_JOIN_ATTEMPTS = 5;
const MAX_JOIN_FORWARDS = 2;

export interface SubscriptionDeliveryInput {
  readonly binding: SubscriptionBinding;
  readonly event: SubscriptionEvent;
}

export async function openSubscriptionStep(input: {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<OpenOutcome> {
  "use step";
  const { binding } = input;
  const idempotencyKey = openIdempotencyKey(binding.id, getWorkflowMetadata().workflowRunId);
  return await subscriptionSource(binding.source.kind).open({
    ctx: await deserializeContext(input.serializedContext),
    binding,
    idempotencyKey,
  });
}

export async function publishOpenOutcomeStep(outcome: OpenOutcome): Promise<void> {
  "use step";
  await publishOutcome(outcome);
}

export async function publishSubscriptionOwnerStep(ownerRunId: string): Promise<void> {
  "use step";
  await publishOutcome({ ownerRunId });
}

export async function joinKeyStep(input: {
  readonly binding: SubscriptionBinding;
  readonly source: SubscriptionKeySource;
  readonly key: string;
}): Promise<void> {
  "use step";
  const { binding, source, key } = input;
  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt++) {
    const ackId = randomUUID();
    const runId =
      (await resumeKey(source, key, { kind: "join", bindingId: binding.id, ackId })) ??
      (
        await startWorkflowOnCurrentDeployment(subscriptionKeyWorkflowReference, [
          { source, key, first: binding.id, ackId },
        ])
      ).runId;
    if (await joined(runId, ackId)) return;
  }
  throw new Error("The subscription's key run kept ending before it accepted the subscription.");
}

async function joined(runId: string, ackId: string): Promise<boolean> {
  let holder = runId;
  for (let hop = 0; hop <= MAX_JOIN_FORWARDS; hop++) {
    const ack = await readFirstPublished<JoinAck>(holder, joinAckNamespace(ackId));
    if (ack.kind !== "value") return false;
    if ("joined" in ack.value) return true;
    holder = ack.value.forwardedTo;
  }
  return false;
}

export async function leaveKeyStep(input: {
  readonly binding: SubscriptionBinding;
  readonly source: SubscriptionKeySource;
  readonly key: string;
}): Promise<void> {
  "use step";
  await resumeKey(input.source, input.key, {
    kind: "leave",
    bindingId: input.binding.id,
  });
}

export async function acknowledgeJoinStep(ackId: string): Promise<void> {
  "use step";
  await publishTo(joinAckNamespace(ackId), { joined: true } satisfies JoinAck);
}

export async function forwardJoinStep(input: {
  readonly source: SubscriptionKeySource;
  readonly key: string;
  readonly bindingId: string;
  readonly ackId: string;
}): Promise<void> {
  "use step";
  const message = { kind: "join", bindingId: input.bindingId, ackId: input.ackId } as const;
  const forwardedTo = await resumeKey(input.source, input.key, message);
  if (forwardedTo === undefined) return;
  await publishTo(joinAckNamespace(input.ackId), { forwardedTo } satisfies JoinAck);
}

export async function fanOutEventStep(input: {
  readonly bindingIds: readonly string[];
  readonly event: SubscriptionEvent;
}): Promise<readonly string[]> {
  "use step";
  const gone = await Promise.all(
    input.bindingIds.map(async (bindingId) =>
      (await resumeOwner(bindingId, { kind: "delivery", event: input.event }))
        ? undefined
        : bindingId,
    ),
  );
  return gone.filter((bindingId) => bindingId !== undefined);
}

export async function retireOwnersStep(input: {
  readonly bindingIds: readonly string[];
}): Promise<void> {
  "use step";
  await Promise.all(
    input.bindingIds.map((bindingId) => resumeOwner(bindingId, { kind: "retire" })),
  );
}

export async function retireSessionSubscriptionsStep(input: {
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  await resumeKey(SESSION_KEY_SOURCE, input.sessionId, { kind: "retire" });
}

export async function reportSessionSubscriptionRetireFailureStep(input: {
  readonly error: unknown;
  readonly sessionId: string;
}): Promise<void> {
  "use step";
  logError(log, "failed to retire the session's subscriptions", input.error, {
    sessionId: input.sessionId,
  });
}

export async function startSubscriptionDeliveryStep(
  input: SubscriptionDeliveryInput,
): Promise<void> {
  "use step";
  await startWorkflowOnDeployment(
    subscriptionDeliveryWorkflowReference,
    [input],
    input.event.origin.deploymentId,
  );
}

export async function dispatchSubscriptionStep(input: SubscriptionDeliveryInput): Promise<void> {
  "use step";
  const { binding, event } = input;
  const bundle = await getCompiledRuntimeAgentBundle({
    compiledArtifactsSource: resolveDurableCompiledArtifactsSource(
      event.origin.compiledArtifactsSource,
    ),
  });
  const ctx = await deserializeContext(await bindingContext(binding, bundle));
  await contextStorage.run(ctx, async () => {
    await subscriptionSource(binding.source.kind).deliver({ ctx, binding, event });
  });
}

export async function closeSubscriptionStep(input: {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly opened: OpenedSubscription;
}): Promise<"pending" | "done"> {
  "use step";
  const ctx = await deserializeContext(input.serializedContext);
  ctx.setVirtualContext(AuthKey, input.binding.auth);
  return contextStorage.run(ctx, () =>
    subscriptionSource(input.binding.source.kind).close({
      ctx,
      binding: input.binding,
      opened: input.opened,
    }),
  );
}

function publishOutcome(outcome: SubscriptionOutcome): Promise<void> {
  return publishTo(SUBSCRIPTION_OUTCOME_NAMESPACE, outcome);
}

async function publishTo<T>(namespace: string, value: T): Promise<void> {
  const writer = getWritable<T>({ namespace }).getWriter();
  try {
    await writer.write(value);
  } finally {
    writer.releaseLock();
  }
}
