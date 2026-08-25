/**
 * Per-tool approval helpers used inside `agent/tools/*.ts` files.
 */

export type {
  Approval,
  ApprovalConfiguration,
  ApprovalContext,
  ApprovalPolicy,
  ApprovalRequest,
  ApprovalResponse,
  ApprovalResponseAuth,
  ApprovalResponseContext,
  ApprovalResponseDecision,
  ApprovalResponsePolicy,
  ApprovalResponseSession,
  ApprovalStatus,
} from "#public/definitions/approval.js";
export { always, never, once } from "#public/tools/approval/policies.js";
