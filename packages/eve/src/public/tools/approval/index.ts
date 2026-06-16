/**
 * Per-tool approval helpers used inside `agent/tools/*.ts` files.
 */

export type { NeedsApprovalContext } from "#public/definitions/tool.js";
export { always, never, once } from "#public/tools/approval/approval-helpers.js";
