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
} from "#approval/definition.js";

/** Validates the function shorthand or explicit request/response/prompt approval shape. */
export function normalizeApproval(value: unknown, message: string): Approval {
  if (typeof value === "function") return value as Approval;

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

/**
 * Validates `defineAgent`'s `approval`: a request policy only. Prompts and response policies stay
 * with the entries that ask, so the agent's policy adds a gate without changing who answers it.
 */
export function normalizeAgentApproval(value: unknown, message: string): ApprovalPolicy {
  return expectFunction<ApprovalPolicy>(value, message);
}
