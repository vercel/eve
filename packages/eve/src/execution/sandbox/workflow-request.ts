import { getStepMetadata } from "#compiled/@workflow/core/index.js";
import type { WorkflowToolRunContext } from "#execution/tools/workflow/ask.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import type { WorkflowSandboxReferenceData } from "#execution/sandbox/workflow-reference.js";

export type WorkflowSandboxResponse =
  | { readonly reference: WorkflowSandboxReferenceData }
  | { readonly error: string };

export async function requestWorkflowSandbox(input: {
  readonly run: WorkflowToolRunContext;
  readonly abortSignal: AbortSignal;
}): Promise<WorkflowSandboxReferenceData> {
  const namespace = `eve.sandbox.${getStepMetadata().stepId}`;
  const stream = getRun(input.run.from.runId).getReadable<WorkflowSandboxResponse>({ namespace });
  const reader = stream.getReader();
  const abort = () => {
    void reader.cancel(input.abortSignal.reason).catch(() => {});
  };
  input.abortSignal.addEventListener("abort", abort, { once: true });
  try {
    input.abortSignal.throwIfAborted();
    if ((await stream.getTailIndex()) < 0) {
      await resumeHook(input.run.owner.inbox, {
        kind: "request",
        from: input.run.from,
        replyTo: namespace,
        request: { kind: "sandbox-request" },
      });
    }
    const result = await reader.read();
    input.abortSignal.throwIfAborted();
    if (result.done) throw new Error("The workflow sandbox owner closed without a response.");
    if ("error" in result.value) throw new Error(result.value.error);
    return result.value.reference;
  } finally {
    input.abortSignal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
