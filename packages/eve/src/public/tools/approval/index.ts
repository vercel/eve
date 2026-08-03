/**
 * Per-tool approval helpers used inside `agent/tools/*.ts` files.
 */

export type { Approval, ApprovalContext, ApprovalStatus } from "#public/definitions/approval.js";
export type {
  ToolApprovalContent,
  ToolApprovalStatusWithContent,
} from "#public/tools/approval/content.js";
export { always, never, once } from "#public/tools/approval/approval-helpers.js";
