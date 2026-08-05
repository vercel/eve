import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  Approval,
  ApprovalPolicy,
  ApprovalResponsePolicy,
} from "#public/definitions/approval.js";

/** Validates the function shorthand or explicit request/response approval shape. */
export function normalizeApproval(value: unknown, message: string): Approval {
  if (typeof value === "function") return value as Approval;

  const approval = expectObjectRecord(value, message);
  expectOnlyKnownKeys(approval, ["request", "response"], message);
  const request = expectFunction<ApprovalPolicy>(approval.request, message);
  if (approval.response === undefined) return { request };
  const response = expectFunction<ApprovalResponsePolicy>(approval.response, message);
  return { request, response };
}
