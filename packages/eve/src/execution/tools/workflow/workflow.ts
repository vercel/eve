import { runBackgroundWorkflowTool } from "#execution/tools/workflow/background-owner.js";
import { createWorkflowToolInvocationReader } from "#execution/tools/workflow/invocation.js";
import { raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
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
  const reader = createWorkflowToolInvocationReader(
    { ...input, execution: input.execution ?? "blocking" },
    control.signal,
    control.cancelled,
  );
  while (true) {
    const read = await raceChannelReads([reader]);
    if (read.next.done) return;
    const message = read.next.value;
    await resumeHookStep(input.owner.inbox, message, {
      ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
    });
    if (message.kind === "outcome") return;
  }
}
