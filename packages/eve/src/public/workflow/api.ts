import * as runtime from "#internal/workflow/runtime.js";

/** The lifecycle state of a workflow run. */
export type WorkflowRunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/** A handle to a workflow run, from {@link start} or {@link getRun}. */
export interface WorkflowRun<T = unknown> {
  readonly runId: string;
  /** Reads the run's current status. */
  readonly status: Promise<WorkflowRunStatus>;
  /** Waits for the run to finish; rejects when it fails or is cancelled. */
  readonly returnValue: Promise<T>;
  /** Cancels the run. */
  cancel(): Promise<void>;
}

/**
 * Starts a run of a `"use workflow"` function with its arguments.
 *
 * eve routes the run to the agent's own workflow queue, so `start` takes no queue or deployment options.
 */
export const start: {
  <TArgs extends unknown[], TResult>(
    workflow: (...args: TArgs) => Promise<TResult>,
    args: TArgs,
  ): Promise<WorkflowRun<TResult>>;
  <TResult>(workflow: () => Promise<TResult>): Promise<WorkflowRun<TResult>>;
} = runtime.start;

/** Returns a handle to an existing run without reading it. */
export const getRun: <T = unknown>(runId: string) => WorkflowRun<T> = runtime.getRun;

/** Delivers a payload to the hook with this token; resolves once the payload is persisted. */
export async function resumeHook<T = unknown>(token: string, payload: T): Promise<void> {
  await runtime.resumeHook(token, payload);
}
