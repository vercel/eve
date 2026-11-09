/**
 * Experimental workflow run operations for routes and functions marked with `"use step"`. APIs may
 * change without notice.
 *
 * eve-owned declarations keep the SDK's wider types out of eve's public API.
 */
import { HookNotFoundError } from "#compiled/@workflow/errors/index.js";
import * as runtime from "#internal/workflow/runtime.js";
import { applicationStreamNamespace } from "#internal/workflow/stream-namespace.js";

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

/**
 * Resolves the ID of the run that holds the hook with this token, or `null` when no hook has it.
 *
 * Use it to find a run whose body called `createHook({ token })` with a token you can derive, then
 * read its streams with {@link getReadable}. Don't use it to decide whether to start a run: a
 * lookup followed by `start` races another caller doing the same.
 */
export async function getHookRunId(token: string): Promise<string | null> {
  try {
    return (await runtime.getHookByToken(token)).runId;
  } catch (error) {
    if (HookNotFoundError.is(error)) return null;
    throw error;
  }
}

/** Options for {@link getReadable}. */
export interface WorkflowReadableOptions {
  /** The stream's `namespace`, as passed to `getWritable` in the run. */
  readonly namespace: string;
  /** The first chunk to read. Negative values count back from the end; `-1` is the latest chunk. */
  readonly startIndex?: number;
}

/**
 * Reads a run's stream named by `namespace`, from `startIndex` (default `0`), following chunks the
 * run writes later. Cancel the stream when you stop reading.
 */
export function getReadable<T = unknown>(
  runId: string,
  options: WorkflowReadableOptions,
): ReadableStream<T> {
  return runtime.getRun(runId).getReadable<T>({
    namespace: applicationStreamNamespace(options?.namespace),
    startIndex: options.startIndex,
  });
}
