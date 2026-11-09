/**
 * Body-side `eve/experimental/workflow`: the driver resolves the entry here so a replayed workflow
 * body gets the Workflow-safe shim, with the same namespace rules as the step and server entry.
 */
import { applicationStreamNamespace } from "#internal/workflow/stream-namespace.js";
import { getWritable as getWorkflowWritable } from "#internal/workflow-bundle/workflow-core-shim.js";

export { getWorkflowMetadata } from "#internal/workflow-bundle/workflow-core-shim.js";

export function getWritable<T = unknown>(options: {
  readonly namespace: string;
}): WritableStream<T> {
  return getWorkflowWritable<T>({ namespace: applicationStreamNamespace(options?.namespace) });
}
