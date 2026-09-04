import { getRun } from "#internal/workflow/runtime.js";
import {
  WORKFLOW_OWNERSHIP_STREAM_NAMESPACE,
  WORKFLOW_CLEANUP_STREAM_NAMESPACE,
  type WorkflowCleanup,
  type WorkflowOwnership,
} from "#execution/workflow-lifecycle-contract.js";

/** Receives the ownership decision made by the started workflow's hook claim. */
export async function readWorkflowOwnership(runId: string): Promise<WorkflowOwnership> {
  const owner = await readWorkflowStreamUntil<WorkflowOwnership>({
    accept: () => true,
    namespace: WORKFLOW_OWNERSHIP_STREAM_NAMESPACE,
    operation: "workflow ownership",
    runId,
    timeoutMs: 30_000,
  });
  if (typeof owner?.runId !== "string" || owner.runId.length === 0) {
    throw new Error(`Workflow "${runId}" closed before acknowledging ownership.`);
  }
  return owner;
}

/** Receives the acknowledgement emitted after successful workflow hook cleanup. */
export async function waitForWorkflowCleanup(runId: string, timeoutMs = 30_000): Promise<void> {
  const cleanup = await readWorkflowStreamUntil<WorkflowCleanup>({
    accept: () => true,
    namespace: WORKFLOW_CLEANUP_STREAM_NAMESPACE,
    operation: "workflow hook cleanup",
    runId,
    timeoutMs,
  });
  if (cleanup?.released !== true) {
    throw new Error(`Workflow "${runId}" closed before acknowledging hook cleanup.`);
  }
}

/** Consumes pushed stream entries until one matches, or the stream closes. */
export async function readWorkflowStreamUntil<T>(input: {
  readonly accept: (value: T) => boolean;
  readonly namespace?: string;
  readonly operation: string;
  readonly runId: string;
  readonly startIndex?: number;
  readonly timeoutMs: number;
}): Promise<T | undefined> {
  const reader = getRun(input.runId)
    .getReadable<T>({ namespace: input.namespace, startIndex: input.startIndex })
    .getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        while (true) {
          const next = await reader.read();
          if (next.done) return undefined;
          if (input.accept(next.value)) return next.value;
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new WorkflowStreamTimeoutError(input.operation)),
          input.timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export class WorkflowStreamTimeoutError extends Error {
  constructor(operation: string) {
    super(`Timed out waiting for ${operation}.`);
    this.name = "WorkflowStreamTimeoutError";
  }
}
