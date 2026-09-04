import { getWritable } from "#compiled/@workflow/core/index.js";
import {
  WORKFLOW_OWNERSHIP_STREAM_NAMESPACE,
  WORKFLOW_CLEANUP_STREAM_NAMESPACE,
  type WorkflowCleanup,
  type WorkflowOwnership,
} from "#execution/workflow-lifecycle-contract.js";

/** Publishes the workflow's claim decision, including the winner of a duplicate start. */
export async function publishWorkflowOwnershipStep(owner: WorkflowOwnership): Promise<void> {
  "use step";

  await publishWorkflowSignal(WORKFLOW_OWNERSHIP_STREAM_NAMESPACE, owner);
}

/** Acknowledges successful hook disposal before callers reuse a continuation token. */
export async function publishWorkflowCleanupStep(): Promise<void> {
  "use step";
  await publishWorkflowSignal<WorkflowCleanup>(WORKFLOW_CLEANUP_STREAM_NAMESPACE, {
    released: true,
  });
}

async function publishWorkflowSignal<T>(namespace: string, value: T): Promise<void> {
  const writer = getWritable<T>({ namespace }).getWriter();
  try {
    await writer.write(value);
    await writer.close();
  } finally {
    writer.releaseLock();
  }
}
