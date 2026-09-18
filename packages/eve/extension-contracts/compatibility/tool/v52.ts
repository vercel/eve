import type { WorkflowStepToolContext } from "#public/tools/index.js";

export function workflowStepSessionId(ctx: WorkflowStepToolContext): string {
  return ctx.session.id;
}
