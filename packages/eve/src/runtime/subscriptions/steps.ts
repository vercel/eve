import { createHash, randomUUID } from "node:crypto";
import { getWorkflowMetadata, getWritable } from "#compiled/@workflow/core/index.js";
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
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
import { getHookByToken, resumeHook } from "#internal/workflow/runtime.js";
import { readFirstPublished } from "#runtime/subscriptions/published-outcome.js";
import { subscriptionSource } from "#runtime/subscriptions/sources/index.js";
import {
  joinAckNamespace,
  sourceRef,
  SUBSCRIPTION_OUTCOME_NAMESPACE,
  subscriptionHookToken,
  subscriptionKeyHookToken,
  type JoinAck,
  type OpenedSubscription,
  type OpenOutcome,
  type SubscriptionBinding,
  type SubscriptionEvent,
  type SubscriptionKeyMessage,
  type SubscriptionOutcome,
  type SubscriptionOwnerMessage,
  type SubscriptionSourceRef,
} from "#runtime/subscriptions/state.js";

const MAX_JOIN_ATTEMPTS = 5;
const MAX_JOIN_FORWARDS = 2;

export interface SubscriptionDeliveryInput {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
  readonly event: SubscriptionEvent;
}

export async function openSubscriptionStep(input: {
  readonly binding: SubscriptionBinding;
  readonly serializedContext: Record<string, unknown>;
}): Promise<OpenOutcome> {
  "use step";
  const { binding } = input;
  const idempotencyKey = createHash("sha256")
    .update(JSON.stringify([binding.id, getWorkflowMetadata().workflowRunId]))
    .digest("hex");
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
  readonly key: string;
}): Promise<void> {
  "use step";
  const { binding, key } = input;
  const source = sourceRef(binding.source);
  for (let attempt = 0; attempt < MAX_JOIN_ATTEMPTS; attempt++) {
    const ackId = randomUUID();
    const runId =
      (await resumeKeyRun(source, key, { kind: "join", bindingId: binding.id, ackId })) ??
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
  readonly key: string;
}): Promise<void> {
  "use step";
  await resumeKeyRun(sourceRef(input.binding.source), input.key, {
    kind: "leave",
    bindingId: input.binding.id,
  });
}

export async function acknowledgeJoinStep(ackId: string): Promise<void> {
  "use step";
  await publishTo(joinAckNamespace(ackId), { joined: true } satisfies JoinAck);
}

export async function forwardJoinStep(input: {
  readonly source: SubscriptionSourceRef;
  readonly key: string;
  readonly bindingId: string;
  readonly ackId: string;
  readonly to: string;
}): Promise<void> {
  "use step";
  const message = { kind: "join", bindingId: input.bindingId, ackId: input.ackId } as const;
  if ((await resumeKeyRun(input.source, input.key, message)) === undefined) return;
  await publishTo(joinAckNamespace(input.ackId), { forwardedTo: input.to } satisfies JoinAck);
}

export async function fanOutEventStep(input: {
  readonly bindingIds: readonly string[];
  readonly event: SubscriptionEvent;
}): Promise<readonly string[]> {
  "use step";
  const gone = await Promise.all(
    input.bindingIds.map(async (bindingId) => {
      try {
        await resumeHook(subscriptionHookToken(bindingId), {
          kind: "delivery",
          event: input.event,
        } satisfies SubscriptionOwnerMessage);
        return undefined;
      } catch (error) {
        if (!HookNotFoundError.is(error)) throw error;
        return bindingId;
      }
    }),
  );
  return gone.filter((bindingId) => bindingId !== undefined);
}

export async function startSubscriptionDeliveryStep(
  input: SubscriptionDeliveryInput,
): Promise<void> {
  "use step";
  const { acceptedDeploymentId } = input.event;
  if (acceptedDeploymentId === undefined)
    await startWorkflowOnCurrentDeployment(subscriptionDeliveryWorkflowReference, [input]);
  else
    await startWorkflowOnDeployment(
      subscriptionDeliveryWorkflowReference,
      [input],
      acceptedDeploymentId,
    );
}

export async function dispatchSubscriptionStep(input: SubscriptionDeliveryInput): Promise<void> {
  "use step";
  const { binding, event } = input;
  const ctx = await deserializeContext(input.serializedContext);
  ctx.setVirtualContext(AuthKey, binding.auth);
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

async function resumeKeyRun(
  source: SubscriptionSourceRef,
  key: string,
  message: SubscriptionKeyMessage,
): Promise<string | undefined> {
  const token = subscriptionKeyHookToken(source, key);
  try {
    const { runId } = await getHookByToken(token);
    await resumeHook(token, message);
    return runId;
  } catch (error) {
    if (HookNotFoundError.is(error)) return undefined;
    throw error;
  }
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
