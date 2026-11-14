import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  AgentApproval,
  Approval,
  ApprovalLabels,
  ApprovalPolicy,
  ApprovalPrompt,
  ApprovalResponsePolicy,
} from "#approval/definition.js";

/** Validates the function shorthand or explicit request/response/prompt/labels approval shape. */
export function normalizeApproval(value: unknown, message: string): Approval {
  if (typeof value === "function") return value as Approval;

  const approval = expectObjectRecord(value, message);
  expectOnlyKnownKeys(approval, ["request", "prompt", "labels", "response"], message);
  const request = expectFunction<ApprovalPolicy>(approval.request, message);
  const prompt = optionalPrompt(approval.prompt, message);
  const labels = optionalLabels(approval.labels, message);
  const response =
    approval.response === undefined
      ? undefined
      : expectFunction<ApprovalResponsePolicy>(approval.response, message);
  return { request, prompt, ...(labels !== undefined && { labels }), response };
}

/**
 * Validates `defineAgent`'s `approval`: a request policy, or an object that can also word every
 * approval. Response policies stay with the entries that ask, so the agent's approval never changes
 * who answers it.
 */
export function normalizeAgentApproval(value: unknown, message: string): AgentApproval {
  if (typeof value === "function") return value as ApprovalPolicy;

  const approval = expectObjectRecord(value, message);
  expectOnlyKnownKeys(approval, ["request", "prompt", "labels"], message);
  const request =
    approval.request === undefined
      ? undefined
      : expectFunction<ApprovalPolicy>(approval.request, message);
  const prompt = optionalPrompt(approval.prompt, message);
  const labels = optionalLabels(approval.labels, message);
  return {
    ...(request !== undefined && { request }),
    ...(prompt !== undefined && { prompt }),
    ...(labels !== undefined && { labels }),
  };
}

function optionalPrompt(value: unknown, message: string): ApprovalPrompt | undefined {
  return value === undefined ? undefined : expectFunction<ApprovalPrompt>(value, message);
}

function optionalLabels(value: unknown, message: string): ApprovalLabels | undefined {
  if (value === undefined) return undefined;
  const labels = expectObjectRecord(value, `${message} Expected "labels" to be an object.`);
  expectOnlyKnownKeys(labels, ["approve", "deny"], message);
  const result: { approve?: string; deny?: string } = {};
  for (const key of ["approve", "deny"] as const) {
    const label = labels[key];
    if (label === undefined) continue;
    if (typeof label !== "string" || label.trim() === "") {
      throw new Error(`${message} Expected "labels.${key}" to be a non-empty string.`);
    }
    result[key] = label;
  }
  return result;
}
