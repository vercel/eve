import type {
  DesiredSlackObject,
  DesiredSlackView,
} from "#public/channels/slack/observation/view.js";

export interface DeliveryReceipt {
  readonly key: string;
  readonly appliedVersion?: string;
  readonly providerMessageId?: string;
  readonly state: "pending" | "confirmed" | "unknown" | "blocked" | "retryable";
  readonly pendingKind?: PlannedSlackOperation["kind"];
  readonly plannedVersion?: string;
  readonly nextAttemptAt?: string;
  readonly errorCode?: string;
  readonly recovered?: boolean;
}

export interface PlannedSlackOperation {
  readonly kind: "create" | "update" | "recover";
  readonly key: string;
  readonly version: string;
  readonly message: DesiredSlackObject;
  readonly providerMessageId?: string;
}

export function slackMessageVersion(message: DesiredSlackObject): string {
  return JSON.stringify([message.kind, message.text]);
}

/** Retained receipts are never deleted just because history is omitted from a newer view. */
export function planSlackDelivery(
  view: DesiredSlackView,
  receipts: Readonly<Record<string, DeliveryReceipt>>,
): readonly PlannedSlackOperation[] {
  const operations: PlannedSlackOperation[] = [];
  for (const message of view.messages) {
    const receipt = receipts[message.key];
    if (receipt?.state === "blocked") continue;
    const version = slackMessageVersion(message);
    if (
      receipt?.state === "unknown" ||
      (receipt?.state === "pending" && receipt.pendingKind !== "update")
    ) {
      operations.push({ kind: "recover", key: message.key, version, message });
    } else if (
      receipt === undefined ||
      (receipt.state === "retryable" && receipt.providerMessageId === undefined)
    ) {
      if (receipt?.state === "retryable" && receipt.errorCode !== "rate_limited") {
        // Without a provider id, even a failed create is ambiguous.
        operations.push({ kind: "recover", key: message.key, version, message });
      } else {
        operations.push({ kind: "create", key: message.key, version, message });
      }
    } else if (receipt.appliedVersion !== version && receipt.providerMessageId !== undefined) {
      operations.push({
        kind: "update",
        key: message.key,
        version,
        message,
        providerMessageId: receipt.providerMessageId,
      });
    }
  }
  return operations.sort(
    (a, b) => (a.message.kind === "activity" ? 1 : 0) - (b.message.kind === "activity" ? 1 : 0),
  );
}
