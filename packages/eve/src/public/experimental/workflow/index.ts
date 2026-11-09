/**
 * Experimental durable primitives for functions marked with `"use workflow"` and `"use step"`.
 * APIs may change without notice.
 *
 * Each export is backed by the vendored Workflow SDK under an eve-owned declaration, so the runtime
 * identity stays single while the SDK's wider types stay out of eve's public API.
 */
import * as sdk from "#internal/workflow/index.js";
import { applicationStreamNamespace } from "#internal/workflow/stream-namespace.js";

/** The current workflow run, from {@link getWorkflowMetadata}. */
export interface WorkflowMetadata {
  readonly workflowName: string;
  readonly workflowRunId: string;
  readonly workflowStartedAt: Date;
  readonly url: string;
}

/** Options for {@link getWritable}. */
export interface WorkflowWritableOptions {
  /**
   * Names the stream within the run. Required, because a run's default stream belongs to eve;
   * names starting with `"eve."` or `"eve:"` are reserved.
   */
  readonly namespace: string;
}

/** Returns metadata for the current workflow run. */
export const getWorkflowMetadata: () => WorkflowMetadata = sdk.getWorkflowMetadata;

/**
 * Returns a durable writable stream on the current run, named by `namespace`. Call it in the body
 * and pass the stream to a step, or call it in a step. Chunks persist with the run; read them with
 * `getReadable(runId, { namespace })` from `eve/experimental/workflow/api`.
 */
export function getWritable<T = unknown>(options: WorkflowWritableOptions): WritableStream<T> {
  return sdk.getWritable<T>({ namespace: applicationStreamNamespace(options?.namespace) });
}
