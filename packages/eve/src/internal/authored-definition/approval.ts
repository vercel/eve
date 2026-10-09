import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  Approval,
  ApprovalPolicy,
  ApprovalPrompt,
  ApprovalResponsePolicy,
  ToolApproval,
} from "#approval/definition.js";

/** Validates the function shorthand or explicit request/response approval shape. */
export function normalizeApproval(value: unknown, message: string): Approval {
  if (typeof value === "function") return value as Approval;

  const approval = expectObjectRecord(value, message);
  expectOnlyKnownKeys(approval, ["request", "response"], message);
  const request = expectFunction<ApprovalPolicy>(approval.request, message);
  const response =
    approval.response === undefined
      ? undefined
      : expectFunction<ApprovalResponsePolicy>(approval.response, message);
  return { request, response };
}

/** Validates a tool approval, including its optional presentation prompt. */
export function normalizeToolApproval(value: unknown, message: string): ToolApproval {
  if (typeof value === "function") return value as ToolApproval;

  const approval = expectObjectRecord(value, message);
  expectOnlyKnownKeys(approval, ["request", "prompt", "response"], message);
  const request = expectFunction<ApprovalPolicy>(approval.request, message);
  const prompt =
    approval.prompt === undefined
      ? undefined
      : expectFunction<ApprovalPrompt>(approval.prompt, message);
  const response =
    approval.response === undefined
      ? undefined
      : expectFunction<ApprovalResponsePolicy>(approval.response, message);
  return { request, prompt, response };
}
