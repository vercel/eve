import { runBackgroundWorkflowTool } from "#execution/tools/workflow/background-owner.js";
import { runWorkflowToolInvocation } from "#execution/tools/workflow/invocation.js";
import { openWorkflowToolRunControlInbox } from "#execution/tools/workflow/run-control.js";
import type {
  BackgroundWorkflowToolRunInput,
  WorkflowToolRunInput,
} from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";

/** Runs a workflow invocation owned by either the waiting turn or its session. */
export async function workflowToolRunWorkflow(
  input: WorkflowToolRunInput | BackgroundWorkflowToolRunInput,
): Promise<void> {
  "use workflow";

  if ("workflow" in input) return runBackgroundWorkflowTool(input);
  const control = openWorkflowToolRunControlInbox(input.hookToken);
  const invocation = runWorkflowToolInvocation(
    { ...input, execution: input.execution ?? "blocking" },
    control.signal,
    control.cancelled,
  );
  for await (const message of invocation) {
    await resumeHookStep(input.owner.inbox, message, {
      ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
    });
    if (message.kind === "outcome") return;
  }
}
