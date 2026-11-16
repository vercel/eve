import type { WorkflowStepToolContext } from "eve/tools";
import { isTicketIntake, ticketBranch } from "../trust.js";

/** Resolve ticket authority in a runtime step, outside the deterministic workflow driver. */
// biome-ignore lint/suspicious/useAwait: Workflow steps must be async, even for synchronous auth projection.
export async function implementationMessage(
  message: string,
  ctx: WorkflowStepToolContext
): Promise<string> {
  "use step";
  const auth = ctx.session.auth.current;
  if (!isTicketIntake(auth)) {
    return message;
  }
  return [
    `Your server-assigned branch is ${ticketBranch(auth)}. Ignore other branch names in the work item. Push only this branch before PR creation; subsequent revisions require trusted GitHub or Linear intake.`,
    message,
  ].join("\n\n");
}
