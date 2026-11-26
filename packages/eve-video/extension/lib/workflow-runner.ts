import type { WorkflowStepToolContext } from "eve/tools";
import { FatalError, type WorkflowWebhookOptions } from "eve/workflow";

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

export interface VideoWorkflowTaskDeps<TRequest = unknown> {
  readonly submit: (
    input: GenerateVideoToolInput,
    ctx: WorkflowStepToolContext,
    webhookUrlCandidate?: string,
  ) => Promise<SubmitVideoStepResult>;
  readonly checkAndPersist: (
    input: GenerateVideoToolInput,
    ctx: WorkflowStepToolContext,
    handle: VideoJobHandle,
  ) => Promise<CheckAndPersistStepResult>;
  readonly verifyAndRespondWebhook: (request: TRequest, secret: string) => Promise<boolean>;
  readonly cleanup: (stagedInputKeys: readonly string[]) => Promise<void>;
  readonly createWebhook: (
    options: WorkflowWebhookOptions & { respondWith: "manual" },
  ) => VideoWebhookHandle<TRequest>;
  readonly getWorkflowMetadata: () => { readonly url: string };
  readonly sleep: (duration: string | number | Date) => Promise<void>;
}

export async function* runVideoWorkflowTask<TRequest = unknown>(
  deps: VideoWorkflowTaskDeps<TRequest>,
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
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
    if (/^https:\/\//i.test(deps.getWorkflowMetadata().url.trim())) {
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
    const fallbackIntervalMs = Math.max(intervalMs, WEBHOOK_FALLBACK_POLL_MS);
    let iterator =
      webhookSecret !== undefined && webhook !== undefined
        ? webhook[Symbol.asyncIterator]()
        : undefined;
    let pendingRequest: Promise<IteratorResult<TRequest>> | undefined;
    let pendingTimer: Promise<"timer"> | undefined;
    let pendingTimerMs = 0;
    let invalidDeliveries = 0;
    let emitProgress = true;

    const mergeOutput = (output: GenerateVideoToolOutput): GenerateVideoToolOutput =>
      pendingWarnings.length === 0
        ? output
        : {
            ...output,
            warnings: [...new Set([...(output.warnings ?? []), ...pendingWarnings])],
          };

    const stopWebhook = () => {
      disposeWebhook();
      iterator = undefined;
      emitProgress = true;
    };

    while (elapsedMs < timeoutMs) {
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

      let waitMs = 0;
      if (iterator !== undefined && webhookSecret !== undefined) {
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
        } else {
          pendingRequest = undefined;
          if (race.entry.done) {
            stopWebhook();
            continue;
          }
          const valid = await deps.verifyAndRespondWebhook(race.entry.value, webhookSecret);
          if (!valid) {
            invalidDeliveries += 1;
            emitProgress = false;
            if (invalidDeliveries >= MAX_INVALID_WEBHOOK_DELIVERIES) {
              stopWebhook();
            }
            continue;
          }
          const settled = await deps.checkAndPersist(input, ctx, handle);
          if (settled.status === "completed") {
            return mergeOutput(settled.output);
          }
          pendingWarnings.push(...settled.warnings);
          stopWebhook();
          continue;
        }
      } else {
        waitMs =
          attempt === 1 && intervalMs >= timeoutMs
            ? Math.floor(timeoutMs / 2)
            : Math.min(intervalMs, timeoutMs - elapsedMs);
        if (waitMs > 0) {
          const timerPromise = deps.sleep(waitMs);
          void timerPromise.catch(() => undefined);
          if (
            (await Promise.race([timerPromise.then(() => "timer" as const), abortRace.promise])) ===
            "aborted"
          ) {
            throw toAbortError(ctx.abortSignal);
          }
          elapsedMs += waitMs;
        }
      }

      const settled = await deps.checkAndPersist(input, ctx, handle);
      if (settled.status === "completed") {
        return mergeOutput(settled.output);
      }
      pendingWarnings.push(...settled.warnings);
      if (iterator === undefined && waitMs === 0) {
        elapsedMs += 1;
      }
    }

    throw new FatalError(
      `Video generation with model "${handle.modelId}"${handle.jobId !== undefined ? ` (job ${handle.jobId})` : ""} timed out after ${timeoutMs}ms.`,
    );
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

function createAbortRace(signal: AbortSignal): {
  readonly promise: Promise<"aborted">;
  readonly cleanup: () => void;
} {
  let resolveAbort!: (value: "aborted") => void;
  const promise = new Promise<"aborted">((resolve) => {
    resolveAbort = resolve;
  });
  const onAbort = () => resolveAbort("aborted");
  signal.addEventListener("abort", onAbort, { once: true });
  return {
    promise,
    cleanup: () => signal.removeEventListener("abort", onAbort),
  };
}

function toAbortError(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason;
  const error = new Error("Video generation was aborted.");
  error.name = "AbortError";
  return error;
}
