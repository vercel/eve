import {
  slackMessageVersion,
  type DeliveryReceipt,
  type PlannedSlackOperation,
} from "#public/channels/slack/observation/plan.js";
import {
  applySlackObservationStep,
  applySlackObservationStatusStep,
  type SlackDeliveryOutcome,
  type SlackObservationDestination,
} from "#public/channels/slack/observation/apply-step.js";

/** The planning step records intent before provider I/O can begin. */
export async function planObservationOperationStep(input: {
  readonly receipt?: DeliveryReceipt;
  readonly operation: PlannedSlackOperation;
}): Promise<DeliveryReceipt> {
  "use step";
  const planned: { -readonly [K in keyof DeliveryReceipt]: DeliveryReceipt[K] } = {
    key: input.operation.key,
    state: "pending",
    plannedVersion: input.operation.version,
    pendingKind: input.operation.kind,
  };
  if (input.receipt?.providerMessageId !== undefined)
    planned.providerMessageId = input.receipt.providerMessageId;
  if (input.receipt?.appliedVersion !== undefined)
    planned.appliedVersion = input.receipt.appliedVersion;
  if (input.receipt?.recovered !== undefined) planned.recovered = input.receipt.recovered;
  return planned;
}

export async function applyObservationDeliveryStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly destination: SlackObservationDestination;
  readonly operation: PlannedSlackOperation;
  readonly ownerId: string;
}): Promise<SlackDeliveryOutcome> {
  "use step";
  return await applySlackObservationStep(input);
}

export async function applyObservationStatusStep(input: {
  readonly serializedContext: Record<string, unknown>;
  readonly destination: SlackObservationDestination;
  readonly status: string;
}): Promise<boolean> {
  "use step";
  return await applySlackObservationStatusStep(input);
}

export async function recordObservationDeliveryStep(input: {
  readonly planned: DeliveryReceipt;
  readonly outcome: SlackDeliveryOutcome;
  readonly operation: PlannedSlackOperation;
}): Promise<DeliveryReceipt> {
  "use step";
  const { planned, outcome, operation } = input;
  if (outcome.kind === "confirmed") {
    const confirmed: { -readonly [K in keyof DeliveryReceipt]: DeliveryReceipt[K] } = {
      key: operation.key,
      state: "confirmed",
      providerMessageId: outcome.ts,
      appliedVersion: slackMessageVersion({ ...operation.message, text: outcome.text }),
    };
    if (outcome.recovered === true) confirmed.recovered = true;
    return confirmed;
  }
  if (outcome.kind === "unknown")
    return { ...planned, state: "blocked", errorCode: "unconfirmed_create" };
  if (outcome.kind === "blocked") return { ...planned, state: "blocked", errorCode: outcome.code };
  return {
    ...planned,
    state: "retryable",
    errorCode: outcome.code,
    nextAttemptAt: new Date(Date.now() + (outcome.retryAfterMs ?? 5_000)).toISOString(),
  };
}
