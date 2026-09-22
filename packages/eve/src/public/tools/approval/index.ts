/**
 * Per-tool approval helpers used inside `agent/tools/*.ts` files.
 */

export type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPolicy,
  ApprovalPrompt,
  ApprovalPromptContext,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalResponseAuth,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalResponsePolicy,
  ApprovalResponseSession,
  ApprovalStatus,
  ToolApproval,
  ToolApprovalConfiguration,
} from "#public/definitions/approval.js";
export type { AutoApprovalOptions } from "#tools/approval/policies.js";
export { always, auto, never, once } from "#tools/approval/policies.js";
