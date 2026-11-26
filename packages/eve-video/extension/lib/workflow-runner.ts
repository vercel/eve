import type { WorkflowStepToolContext } from "eve/tools";
import type { WorkflowWebhookOptions } from "eve/workflow";

import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
  VideoJobHandle,
} from "./types.ts";
import type { CheckAndPersistStepResult, SubmitVideoStepResult } from "./workflow-steps.ts";

export const WEBHOOK_FALLBACK_POLL_MS = 60_000;
export const MAX_INVALID_WEBHOOK_DELIVERIES = 10;

export interface VideoWebhookHandle<TRequest = unknown> extends AsyncIterable<TRequest> {
  readonly url: string;
  getConflict(): Promise<{ readonly runId: string } | null>;
  dispose(): void;
}

export interface VideoWorkflowTaskDeps<
  TRequest = unknown,
  TCtx extends { readonly abortSignal: AbortSignal } = WorkflowStepToolContext,
> {
  readonly submit: (
    input: GenerateVideoToolInput,
    ctx: TCtx,
    webhookUrlCandidate?: string,
  ) => Promise<SubmitVideoStepResult>;
  readonly checkAndPersist: (
    input: GenerateVideoToolInput,
    ctx: TCtx,
    handle: VideoJobHandle,
  ) => Promise<CheckAndPersistStepResult>;
  readonly verifyAndRespondWebhook: (request: TRequest, secret: string) => Promise<boolean>;
  readonly cleanup: (stagedInputKeys: readonly string[]) => Promise<void>;
  readonly createWebhook: (
    options: WorkflowWebhookOptions & { respondWith: "manual" },
  ) => VideoWebhookHandle<TRequest>;
  readonly getWorkflowMetadata: () => { readonly url: string };
  readonly sleep: (duration: string | number | Date) => Promise<void>;
  readonly createFatalError: (message: string) => Error;
}

export async function* runVideoWorkflowTask<
  TRequest = unknown,
  TCtx extends { readonly abortSignal: AbortSignal } = WorkflowStepToolContext,
>(
  deps: VideoWorkflowTaskDeps<TRequest, TCtx>,
  input: GenerateVideoToolInput,
  ctx: TCtx,
): AsyncGenerator<GenerateVideoToolProgress, GenerateVideoToolOutput, void> {
  if (ctx.abortSignal.aborted) {
    throw toAbortError(ctx.abortSignal);
  }

  let webhook: VideoWebhookHandle<TRequest> | undefined;
  let webhookDisposed = false;
  const disposeWebhook = () => {
    if (webhook !== undefined && !webhookDisposed) {
      webhookDisposed = true;
      webhook.dispose();
    }
  };

  const abortRace = createAbortRace(ctx.abortSignal);
  let stagedInputKeys: readonly string[] = [];

  try {
    let webhookUrlCandidate: string | undefined;
    if (isHttpsHost(deps.getWorkflowMetadata().url)) {
      webhook = deps.createWebhook({ respondWith: "manual" });
      await webhook.getConflict();
      webhookUrlCandidate = webhook.url;
    }

    const submitted = await deps.submit(input, ctx, webhookUrlCandidate);
    if (submitted.kind === "completed") {
      return submitted.output;
    }

    const { handle, intervalMs, timeoutMs } = submitted;
    stagedInputKeys = handle.stagedInputKeys ?? [];
    const webhookSecret =
      submitted.useWebhook && webhook !== undefined ? handle.webhookSigningSecret : undefined;
    if (webhookSecret === undefined) {
      disposeWebhook();
    }

    let elapsedMs = 0;
    let attempt = 0;
    const pendingWarnings: string[] = [];

    if (webhookSecret !== undefined && webhook !== undefined) {
      const fallbackIntervalMs = Math.max(intervalMs, WEBHOOK_FALLBACK_POLL_MS);
      const iterator = webhook[Symbol.asyncIterator]();
      let pendingRequest: Promise<IteratorResult<TRequest>> | undefined;
      let pendingTimer: Promise<"timer"> | undefined;
      let pendingTimerMs = 0;
      let invalidDeliveries = 0;
      let webhookActive = true;
      let emitProgress = true;

      while (webhookActive && elapsedMs < timeoutMs) {
        if (ctx.abortSignal.aborted) {
          throw toAbortError(ctx.abortSignal);
        }
        if (emitProgress) {
          attempt += 1;
          yield {
            status: "generating",
            model: handle.modelId,
            ...(handle.jobId !== undefined && { jobId: handle.jobId }),
            elapsedSeconds: Math.floor(elapsedMs / 1000),
            attempt,
          };
        }

        if (pendingRequest === undefined) {
          pendingRequest = iterator.next();
          void pendingRequest.catch(() => undefined);
        }
        if (pendingTimer === undefined) {
          pendingTimerMs = Math.min(fallbackIntervalMs, timeoutMs - elapsedMs);
          pendingTimer = deps.sleep(pendingTimerMs).then(() => "timer" as const);
          void pendingTimer.catch(() => undefined);
        }

        const race = await Promise.race([
          pendingRequest.then((entry) => ({ kind: "webhook" as const, entry })),
          pendingTimer.then(() => ({ kind: "timer" as const })),
          abortRace.promise.then(() => ({ kind: "aborted" as const })),
        ]);

        if (race.kind === "aborted") {
          throw toAbortError(ctx.abortSignal);
        }

        if (race.kind === "timer") {
          pendingTimer = undefined;
          elapsedMs += pendingTimerMs;
          emitProgress = true;
          const settled = await deps.checkAndPersist(input, ctx, handle);
          if (settled.status === "completed") {
            return mergeOutputWarnings(settled.output, pendingWarnings);
          }
          appendUniqueWarnings(pendingWarnings, settled.warnings);
          continue;
        }

        pendingRequest = undefined;
        if (race.entry.done) {
          webhookActive = false;
          break;
        }

        const valid = await deps.verifyAndRespondWebhook(race.entry.value, webhookSecret);
        if (!valid) {
          invalidDeliveries += 1;
          emitProgress = false;
          if (invalidDeliveries >= MAX_INVALID_WEBHOOK_DELIVERIES) {
            disposeWebhook();
            webhookActive = false;
            break;
          }
          continue;
        }

        const settled = await deps.checkAndPersist(input, ctx, handle);
        if (settled.status === "completed") {
          return mergeOutputWarnings(settled.output, pendingWarnings);
        }
        appendUniqueWarnings(pendingWarnings, settled.warnings);
        disposeWebhook();
        webhookActive = false;
        break;
      }

      disposeWebhook();
    }

    while (elapsedMs < timeoutMs) {
      if (ctx.abortSignal.aborted) {
        throw toAbortError(ctx.abortSignal);
      }
      attempt += 1;
      yield {
        status: "generating",
        model: handle.modelId,
        ...(handle.jobId !== undefined && { jobId: handle.jobId }),
        elapsedSeconds: Math.floor(elapsedMs / 1000),
        attempt,
      };

      const remainingMs = timeoutMs - elapsedMs;
      const waitMs =
        attempt === 1 && intervalMs >= timeoutMs
          ? Math.floor(timeoutMs / 2)
          : Math.min(intervalMs, remainingMs);

      if (waitMs > 0) {
        const timerPromise = deps.sleep(waitMs);
        void timerPromise.catch(() => undefined);
        const race = await Promise.race([
          timerPromise.then(() => "timer" as const),
          abortRace.promise,
        ]);
        if (race === "aborted") {
          throw toAbortError(ctx.abortSignal);
        }
        elapsedMs += waitMs;
      }

      const settled = await deps.checkAndPersist(input, ctx, handle);
      if (settled.status === "completed") {
        return mergeOutputWarnings(settled.output, pendingWarnings);
      }
      appendUniqueWarnings(pendingWarnings, settled.warnings);
      if (waitMs === 0) {
        elapsedMs += 1;
      }
    }

    throw deps.createFatalError(formatTimeoutMessage(handle.modelId, timeoutMs, handle.jobId));
  } finally {
    abortRace.cleanup();
    disposeWebhook();
    if (stagedInputKeys.length > 0) {
      await Promise.resolve()
        .then(() => deps.cleanup(stagedInputKeys))
        .catch(() => undefined);
    }
  }
}

function isHttpsHost(url: string): boolean {
  return /^https:\/\//i.test(url.trim());
}

function createAbortRace(signal: AbortSignal): {
  readonly promise: Promise<"aborted">;
  readonly cleanup: () => void;
} {
  if (signal.aborted) {
    return { promise: Promise.resolve("aborted"), cleanup: () => {} };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<"aborted">((resolve) => {
    onAbort = () => resolve("aborted");
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    cleanup: () => {
      if (onAbort !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

function toAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Video generation was aborted.");
  error.name = "AbortError";
  return error;
}

function appendUniqueWarnings(target: string[], incoming: readonly string[]): void {
  for (const warning of incoming) {
    if (!target.includes(warning)) target.push(warning);
  }
}

function mergeOutputWarnings(
  output: GenerateVideoToolOutput,
  pendingWarnings: readonly string[],
): GenerateVideoToolOutput {
  if (pendingWarnings.length === 0) return output;
  const merged: string[] = [...(output.warnings ?? [])];
  appendUniqueWarnings(merged, pendingWarnings);
  return { ...output, warnings: merged };
}

function formatTimeoutMessage(modelId: string, timeoutMs: number, jobId?: string): string {
  return `Video generation with model "${modelId}"${jobId !== undefined ? ` (job ${jobId})` : ""} timed out after ${timeoutMs}ms.`;
}
