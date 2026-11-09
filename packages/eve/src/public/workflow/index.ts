/**
 * Durable primitives for functions marked with `"use workflow"`.
 *
 * Each export is the vendored Workflow SDK value under an eve-owned declaration, so the runtime
 * identity stays single while the SDK's wider types stay out of eve's public API.
 */
import * as sdk from "#internal/workflow/index.js";
import type { JsonValue } from "#shared/json.js";

/** Options for {@link createHook}. */
export interface WorkflowHookOptions {
  /** A deterministic token for `resumeHook`; generated when omitted. */
  token?: string;
  /** JSON metadata stored with the hook. */
  metadata?: JsonValue;
}

/** A durable hook. Await it for the next payload, or iterate it for every payload. */
export interface WorkflowHook<T = unknown> extends AsyncIterable<T>, PromiseLike<T> {
  /** The token that `resumeHook` uses to deliver a payload. */
  readonly token: string;
  /**
   * Registers the hook now and resolves the run that already owns its token, or `null`.
   * Await it before handing the token or URL to another system.
   */
  getConflict(): Promise<{ readonly runId: string } | null>;
  /** Releases the token so no further payloads are delivered. */
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Options for {@link createWebhook}. */
export interface WorkflowWebhookOptions {
  /** The HTTP response sent to the caller, or `"manual"` to answer through `request.respondWith`. */
  respondWith?: Response | "manual";
}

/** A request delivered to a webhook created with `respondWith: "manual"`. */
export interface WorkflowWebhookRequest extends Request {
  /** Sends the HTTP response for this request. */
  respondWith(response: Response): Promise<void>;
}

/** A durable hook resumed by HTTP requests to its URL. */
export interface WorkflowWebhook<T extends Request = Request> extends WorkflowHook<T> {
  /** The URL an external system calls to resume the workflow. */
  readonly url: string;
}

/** The current workflow run, from {@link getWorkflowMetadata}. */
export interface WorkflowMetadata {
  readonly workflowName: string;
  readonly workflowRunId: string;
  readonly workflowStartedAt: Date;
  readonly url: string;
}

/** An error that fails a step or workflow without retrying. */
export interface FatalError extends Error {
  readonly fatal: boolean;
}

/** An error that retries a step, optionally after a delay. */
export interface RetryableError extends Error {
  readonly retryAfter: Date;
}

/** Creates a durable hook that a route or step resumes with `resumeHook`. */
// The SDK types metadata as its wider serializable union with mutable arrays; JSON is a subset.
export const createHook = sdk.createHook as <T = unknown>(
  options?: WorkflowHookOptions,
) => WorkflowHook<T>;

/** Creates a durable hook resumed by an HTTP request to its `url`. */
export const createWebhook: {
  (
    options: WorkflowWebhookOptions & { respondWith: "manual" },
  ): WorkflowWebhook<WorkflowWebhookRequest>;
  (options?: WorkflowWebhookOptions): WorkflowWebhook;
} = sdk.createWebhook;

/** Suspends the workflow for a duration such as `"1h"`, a number of milliseconds, or until a date. */
// The SDK declares one overload per input kind, which a union argument cannot call.
export const sleep = sdk.sleep as (duration: string | number | Date) => Promise<void>;

/** Returns metadata for the current workflow run. */
export const getWorkflowMetadata: () => WorkflowMetadata = sdk.getWorkflowMetadata;

export const FatalError: {
  new (message: string): FatalError;
  readonly prototype: FatalError;
} = sdk.FatalError;

export const RetryableError: {
  new (message: string, options?: { retryAfter?: string | number | Date }): RetryableError;
  readonly prototype: RetryableError;
} = sdk.RetryableError;
