import { sleep as workflowSleep } from "#compiled/@workflow/core/index.js";

import { createWorkflowBodyRef } from "#execution/tools/workflow/body.js";
import type { WorkflowToolRunMessage } from "#execution/tools/workflow/messages.js";
import { createWorkflowToolInvocationReader } from "#execution/tools/workflow/invocation.js";
import { raceChannelReads } from "#execution/tools/workflow/owner-channels.js";
import { openWorkflowToolRunControlInbox } from "#execution/tools/workflow/run-control.js";
import type { WorkflowToolRunInput } from "#execution/tools/workflow/types.js";
import { resumeHookStep } from "#execution/tools/workflow/resume-hook-step.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";

const CANCEL_GRACE = "30s";

/** Runs one authored workflow tool call and reports to its declared owner hook. */
export async function workflowToolRunWorkflow(input: WorkflowToolRunInput): Promise<void> {
  "use workflow";

  const control = openWorkflowToolRunControlInbox(input.hookToken);
  const invocationInput = { ...input, execution: input.execution ?? "blocking" } as const;
  const reader = createWorkflowToolInvocationReader(invocationInput, control.signal);
  try {
    while (true) {
      const read = await raceChannelReads([reader], control.cancelled);
      if (read === "cancel" || read.next.done) return;
      await deliver(read.next.value);
      if (read.next.value.kind === "outcome") return;
    }
  } catch (error) {
    if (!control.signal.aborted) {
      await deliver({
        from: createWorkflowBodyRef(invocationInput),
        kind: "outcome",
        result: { error: normalizeSerializableError(error), status: "failed" },
      });
      return;
    }
    await Promise.race([drainInvocation().catch(() => {}), workflowSleep(CANCEL_GRACE)]);
    await deliver({
      from: createWorkflowBodyRef(invocationInput),
      kind: "outcome",
      result: { reason: control.reason(), status: "cancelled" },
    });
  }

  async function drainInvocation(): Promise<void> {
    while (true) {
      const read = await raceChannelReads([reader]);
      if (read.next.done) return;
      if (read.next.value.kind === "outcome") return;
      await deliver(read.next.value);
    }
  }

  async function deliver(message: WorkflowToolRunMessage): Promise<void> {
    await resumeHookStep(input.owner.inbox, message, {
      ifPresent: message.kind === "outcome" && message.result.status === "cancelled",
    });
  }
}
