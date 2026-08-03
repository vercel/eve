import type { ToolApprovalContent } from "#public/tools/approval/content.js";
import type { InputRequest } from "#runtime/input/types.js";
import { toolApprovalContentSchema } from "#shared/tool-approval-content-schema.js";

/** Internal request carrying review content alongside the stable input protocol. */
export type InputRequestWithToolApprovalContent = InputRequest & {
  readonly content: ToolApprovalContent;
};

/** Reads validated review content from an internal tool-approval request. */
export function getToolApprovalContent(value: InputRequest): ToolApprovalContent | undefined {
  if (!("content" in value)) return undefined;
  const parsed = toolApprovalContentSchema.safeParse(value.content);
  return parsed.success ? parsed.data : undefined;
}
