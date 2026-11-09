/**
 * Experimental durable primitives for functions marked with `"use workflow"`. APIs may change
 * without notice.
 *
 * Each export is the vendored Workflow SDK value under an eve-owned declaration, so the runtime
 * identity stays single while the SDK's wider types stay out of eve's public API.
 */
import * as sdk from "#internal/workflow/index.js";

/** The current workflow run, from {@link getWorkflowMetadata}. */
export interface WorkflowMetadata {
  readonly workflowName: string;
  readonly workflowRunId: string;
  readonly workflowStartedAt: Date;
  readonly url: string;
}

/** Returns metadata for the current workflow run. */
export const getWorkflowMetadata: () => WorkflowMetadata = sdk.getWorkflowMetadata;
