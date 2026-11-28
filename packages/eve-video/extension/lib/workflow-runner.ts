import type { WorkflowStepToolContext } from "eve/tools";
import { FatalError, type WorkflowWebhookOptions } from "eve/workflow";

import type * as t from "./types.ts";
import type { CheckAndPersistStepResult, SubmitVideoStepResult } from "./workflow-steps.ts";

export const WEBHOOK_FALLBACK_POLL_MS = 20_000;
export const MAX_INVALID_WEBHOOK_DELIVERIES = 10;

export interface VideoWebhookHandle<TRequest = unknown> extends AsyncIterable<TRequest> {
  readonly url: string;
  getConflict(): Promise<{ readonly runId: string } | null>;
  dispose(): void;
}

export interface VideoWorkflowTaskDeps<TRequest = unknown> {
  readonly submit: (
    input: t.GenerateVideoToolInput,
    ctx: WorkflowStepToolContext,
    webhookUrl?: string,
  ) => Promise<SubmitVideoStepResult>;
  readonly checkAndPersist: (
    input: t.GenerateVideoToolInput,
    ctx: WorkflowStepToolContext,
    handle: t.VideoJobHandle,
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
  input: t.GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
): AsyncGenerator<t.GenerateVideoToolProgress, t.GenerateVideoToolOutput, void> {
  const {
    submit,
    checkAndPersist,
    verifyAndRespondWebhook,
    cleanup,
    createWebhook,
    getWorkflowMetadata,
    sleep,
  } = deps;
  const abortError = () =>
    ctx.abortSignal.reason ??
    Object.assign(new Error("Video generation was aborted."), { name: "AbortError" });
  if (ctx.abortSignal.aborted) throw abortError();

  let webhook: VideoWebhookHandle<TRequest> | undefined;
  let disposed = false;
  const dispose = () => {
    if (webhook && !disposed) {
      disposed = true;
      webhook.dispose();
    }
  };
  let resolveAbort!: (v: "aborted") => void;
  const abortPromise = new Promise<"aborted">((r) => {
    resolveAbort = r;
  });
  const onAbort = () => resolveAbort("aborted");
  ctx.abortSignal.addEventListener("abort", onAbort, { once: true });
  let stagedKeys: readonly string[] = [];

  try {
    let webhookUrl: string | undefined;
    if (/^https:\/\//i.test(getWorkflowMetadata().url.trim())) {
      webhook = createWebhook({ respondWith: "manual" });
      await webhook.getConflict();
      webhookUrl = webhook.url;
    }

    const submitted = await submit(input, ctx, webhookUrl);
    if (submitted.kind === "completed") return submitted.output;

    const { handle, intervalMs, timeoutMs } = submitted;
    stagedKeys = handle.stagedInputKeys ?? [];
    const secret = submitted.useWebhook && webhook ? handle.webhookSigningSecret : undefined;
    if (!secret) dispose();

    let [elapsedMs, attempt, invalid, pendingTimerMs] = [0, 0, 0, 0];
    let emitProgress = true;
    let pendingReq: Promise<IteratorResult<TRequest>> | undefined;
    let pendingTimer: Promise<"timer"> | undefined;
    const warnings: string[] = [];
    const fallbackMs = Math.max(intervalMs, WEBHOOK_FALLBACK_POLL_MS);
    let iter = secret && webhook ? webhook[Symbol.asyncIterator]() : undefined;
    const stopWebhook = () => {
      dispose();
      iter = undefined;
      emitProgress = true;
    };

    while (elapsedMs < timeoutMs) {
      if (ctx.abortSignal.aborted) throw abortError();
      if (emitProgress) {
        yield {
          status: "generating",
          model: handle.modelId,
          ...(handle.jobId !== undefined && { jobId: handle.jobId }),
          elapsedSeconds: Math.floor(elapsedMs / 1000),
          attempt: ++attempt,
        };
      }

      let waitMs = 0;
      let fromWebhook = false;
      if (iter && secret) {
        if (!pendingReq) void (pendingReq = iter.next()).catch(() => undefined);
        if (!pendingTimer) {
          pendingTimerMs = Math.min(fallbackMs, timeoutMs - elapsedMs);
          void (pendingTimer = sleep(pendingTimerMs).then(() => "timer" as const)).catch(
            () => undefined,
          );
        }
        const race = await Promise.race([
          pendingReq.then((entry) => ({ kind: "webhook" as const, entry })),
          pendingTimer.then(() => ({ kind: "timer" as const })),
          abortPromise.then(() => ({ kind: "aborted" as const })),
        ]);
        if (race.kind === "aborted") throw abortError();
        if (race.kind === "timer") {
          pendingTimer = undefined;
          elapsedMs += pendingTimerMs;
          emitProgress = true;
        } else {
          pendingReq = undefined;
          if (race.entry.done) {
            stopWebhook();
            continue;
          }
          if (!(await verifyAndRespondWebhook(race.entry.value, secret))) {
            emitProgress = false;
            if (++invalid >= MAX_INVALID_WEBHOOK_DELIVERIES) stopWebhook();
            continue;
          }
          fromWebhook = true;
        }
      } else {
        waitMs =
          attempt === 1 && intervalMs >= timeoutMs
            ? Math.floor(timeoutMs / 2)
            : Math.min(intervalMs, timeoutMs - elapsedMs);
        if (waitMs > 0) {
          const timer = sleep(waitMs);
          void timer.catch(() => undefined);
          if (
            (await Promise.race([timer.then(() => "timer" as const), abortPromise])) === "aborted"
          )
            throw abortError();
          elapsedMs += waitMs;
        }
      }

      const settled = await checkAndPersist(input, ctx, handle);
      if (settled.status === "completed") {
        return warnings.length
          ? {
              ...settled.output,
              warnings: [...new Set([...(settled.output.warnings ?? []), ...warnings])],
            }
          : settled.output;
      }
      warnings.push(...settled.warnings);
      if (fromWebhook) stopWebhook();
      else if (!iter && waitMs === 0) elapsedMs += 1;
    }

    throw new FatalError(
      `Video generation with model "${handle.modelId}"${handle.jobId ? ` (job ${handle.jobId})` : ""} timed out after ${timeoutMs}ms.`,
    );
  } finally {
    ctx.abortSignal.removeEventListener("abort", onAbort);
    dispose();
    if (stagedKeys.length)
      try {
        await cleanup(stagedKeys);
      } catch {}
  }
}
