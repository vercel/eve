import type { ModelMessage } from "ai";

import type { ApprovalContext } from "#approval/definition.js";

/**
 * Approval contexts built for the AI SDK's re-check of a call a person already
 * approved. The SDK re-runs the approval policy just before such a call runs,
 * and a `denied` result there cancels it.
 */
const rechecks = new WeakSet<object>();

/** Whether `messages` hold a person's approval of `toolCallId`. */
export function isApprovedToolCall(messages: readonly ModelMessage[], toolCallId: string): boolean {
  const approvalIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "tool-approval-request" && part.toolCallId === toolCallId) {
        approvalIds.add(part.approvalId);
      }
    }
  }
  if (approvalIds.size === 0) return false;
  return messages.some(
    (message) =>
      message.role === "tool" &&
      message.content.some(
        (part) =>
          part.type === "tool-approval-response" &&
          part.approved &&
          approvalIds.has(part.approvalId),
      ),
  );
}

export function markApprovalRecheck<T extends ApprovalContext>(context: T): T {
  rechecks.add(context);
  return context;
}

/** Whether `context` is the re-check of an approved call just before it runs. */
export function isApprovalRecheck(context: ApprovalContext): boolean {
  return rechecks.has(context);
}
