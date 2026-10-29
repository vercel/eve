import type { ApprovalStatus } from "#approval/definition.js";
import type { ClearedBy } from "#protocol/session-events/families/call.js";
import type { RememberRequest } from "#approval/evaluation.js";

export type NormalizedApprovalStatus = Exclude<ApprovalStatus, boolean>;

/** Normalize legacy predicates and reject malformed JavaScript policy returns before execution. */
export function normalizeApprovalStatus(value: unknown): NormalizedApprovalStatus {
  if (value === undefined) return undefined;
  if (value === false) return "not-applicable";
  if (value === true) return "user-approval";
  const type = typeof value === "object" && value !== null ? Reflect.get(value, "type") : value;
  if (
    type !== "not-applicable" &&
    type !== "approved" &&
    type !== "denied" &&
    type !== "user-approval"
  ) {
    throw new Error("An approval policy must return an approval status, a boolean, or undefined.");
  }
  if (typeof value !== "object" || value === null) return type;
  const reason: unknown = Reflect.get(value, "reason");
  if (
    reason !== undefined &&
    (typeof reason !== "string" || (type !== "approved" && type !== "denied"))
  ) {
    throw new Error("Only approved and denied approval statuses accept a string reason.");
  }
  return type === "approved" || type === "denied"
    ? reason === undefined
      ? { type }
      : { type, reason }
    : { type };
}

export interface ApprovalDecision {
  readonly remember?: RememberRequest;
  readonly clearedBy?: ClearedBy;
  readonly denied: boolean;
  readonly awaitsPerson?: true;
  readonly reason?: string;
}

export function approvalDecision(value: unknown): ApprovalDecision {
  const status = normalizeApprovalStatus(value);
  const type = typeof status === "object" ? status.type : status;
  const reason = typeof status === "object" ? status.reason : undefined;
  if (type === "user-approval") return { denied: false, awaitsPerson: true };
  if (type === "denied") return { denied: true, reason };
  if (type === "approved") return { denied: false, clearedBy: { policy: "approval" } };
  return { denied: false };
}
