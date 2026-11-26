import type { WorkflowStepToolContext } from "eve/tools";
import { FatalError, type WorkflowWebhookRequest } from "eve/workflow";

import extension from "../extension.ts";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_POLL_TIMEOUT_MS,
  NO_DESTINATION_ERROR,
  checkVideoJob,
  generateVideos,
  isTransientProviderError,
  normalizeOptionalPath,
  persistVideos,
  startVideoJob,
} from "./engine.ts";
import { assertSafePublicUrl } from "./media.ts";
import { resolveConfiguredModel, resolveJobModel } from "./model.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import { createIdempotencyKey } from "./tools.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GeneratedVideoItem,
  VideoJobHandle,
  VideoJobStatus,
  VideoModelLike,
} from "./types.ts";
import { verifyGatewayWebhookSignature } from "./webhook.ts";

const CLEANUP_TIMEOUT_MS = 15_000;
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;

export type SubmitVideoStepResult =
  | {
      readonly kind: "completed";
      readonly output: GenerateVideoToolOutput;
    }
  | {
      readonly kind: "async";
      readonly handle: VideoJobHandle;
      readonly useWebhook: boolean;
      readonly intervalMs: number;
      readonly timeoutMs: number;
    };

export type CheckAndPersistStepResult =
  | {
      readonly status: "pending";
      readonly warnings: readonly string[];
    }
  | {
      readonly status: "completed";
      readonly output: GenerateVideoToolOutput;
    };

export async function runSubmitVideoStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrlCandidate?: string,
): Promise<SubmitVideoStepResult> {
  ctx.abortSignal.throwIfAborted();
  const config = extension.config;
  const idempotencyKey = createIdempotencyKey(ctx.session.id, ctx.callId);

  let model: VideoModelLike;
  try {
    ({ model } = resolveConfiguredModel(config, input.model));
  } catch (error) {
    throw new FatalError(errorMessage(error));
  }

  const supportsAsync = typeof model.doStart === "function" && typeof model.doStatus === "function";
  if (!supportsAsync) {
    try {
      const generator = generateVideos({
        config,
        input,
        getSandbox: () => ctx.getSandbox(),
        sessionId: ctx.session.id,
        idempotencyKey,
        signal: ctx.abortSignal,
      });
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          return { kind: "completed", output: next.value };
        }
      }
    } catch (error) {
      rethrowStepError(error, ctx.abortSignal);
    }
  }

  const intervalMs = config.poll?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = config.poll?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new FatalError(`Invalid poll.intervalMs: ${intervalMs}.`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new FatalError(
      `Invalid poll.timeoutMs: expected a positive number, received ${timeoutMs}.`,
    );
  }

  let outputPath: string | undefined;
  try {
    outputPath = normalizeOptionalPath(input.path);
  } catch (error) {
    throw new FatalError(errorMessage(error));
  }

  const storage = resolveConfiguredStorage(config.storage);
  if (
    storage === undefined &&
    outputPath === undefined &&
    config.allowTemporaryProviderUrl !== true
  ) {
    throw new FatalError(NO_DESTINATION_ERROR);
  }

  let prefetchedSandbox: Awaited<ReturnType<WorkflowStepToolContext["getSandbox"]>> | undefined;
  if (outputPath !== undefined) {
    try {
      prefetchedSandbox = await ctx.getSandbox();
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      throw new FatalError(
        `Writing generated videos to "path" requires an agent sandbox. Configure a sandbox on the agent, or omit "path" and use configured video storage. (${errorMessage(error)})`,
      );
    }
  }

  let useWebhook = false;
  if (
    config.webhook !== "never" &&
    typeof model.handleWebhookOption === "function" &&
    webhookUrlCandidate !== undefined
  ) {
    try {
      await assertSafePublicUrl(webhookUrlCandidate, { resolveDns: false });
      useWebhook = true;
    } catch {
      useWebhook = false;
    }
  }

  let handle: VideoJobHandle;
  try {
    handle = await startVideoJob({
      config,
      input,
      ...(storage !== undefined && { storage }),
      getSandbox:
        prefetchedSandbox !== undefined ? async () => prefetchedSandbox : () => ctx.getSandbox(),
      idempotencyKey,
      ...(useWebhook && { webhookUrl: webhookUrlCandidate }),
      signal: ctx.abortSignal,
    });
  } catch (error) {
    rethrowStepError(error, ctx.abortSignal);
  }

  return {
    kind: "async",
    handle,
    useWebhook: useWebhook && handle.webhookSigningSecret !== undefined,
    intervalMs,
    timeoutMs,
  };
}

export async function runVerifyAndRespondWebhookStep(
  request: WorkflowWebhookRequest,
  secret: string,
): Promise<boolean> {
  const signatureHeader = request.headers.get("x-ai-gateway-signature");
  if (signatureHeader === null || signatureHeader.trim().length === 0) {
    await cancelRequestBody(request);
    await respondBestEffort(request, 401);
    return false;
  }

  const rawBody = await readBoundedWebhookBody(request, MAX_WEBHOOK_BODY_BYTES);
  if (rawBody === null) {
    await respondBestEffort(request, 413);
    return false;
  }

  const valid = verifyGatewayWebhookSignature({
    header: signatureHeader,
    rawBody,
    secret,
  });
  await respondBestEffort(request, valid ? 204 : 401);
  return valid;
}

export async function runCheckAndPersistStep(
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  handle: VideoJobHandle,
): Promise<CheckAndPersistStepResult> {
  ctx.abortSignal.throwIfAborted();
  const config = extension.config;

  try {
    const { model } = resolveJobModel(config, handle.modelId);
    if (typeof model.doStatus !== "function") {
      throw new FatalError(
        `Video model "${handle.modelId}" does not support asynchronous status checks.`,
      );
    }
  } catch (error) {
    if (error instanceof FatalError) throw error;
    throw new FatalError(errorMessage(error));
  }

  let status: VideoJobStatus;
  try {
    status = await checkVideoJob({
      config,
      modelId: handle.modelId,
      operation: handle.operation,
      maxRetries: 0,
      signal: ctx.abortSignal,
    });
  } catch (error) {
    rethrowStepError(error, ctx.abortSignal);
  }

  if (status.status === "pending") {
    return { status: "pending", warnings: status.warnings };
  }
  if (status.status === "error") {
    throw new FatalError(status.error || "Video generation failed.");
  }

  let outputPath: string | undefined;
  try {
    outputPath = normalizeOptionalPath(input.path);
  } catch (error) {
    throw new FatalError(errorMessage(error));
  }

  const storage = resolveConfiguredStorage(config.storage);
  let sandbox: Awaited<ReturnType<WorkflowStepToolContext["getSandbox"]>> | undefined;
  if (outputPath !== undefined) {
    try {
      sandbox = await ctx.getSandbox();
    } catch (error) {
      if (ctx.abortSignal.aborted) throw error;
      throw new FatalError(
        `Writing generated videos to "path" requires an agent sandbox. Configure a sandbox on the agent, or omit "path" and use configured video storage. (${errorMessage(error)})`,
      );
    }
  }

  let persisted: readonly GeneratedVideoItem[];
  try {
    persisted = await persistVideos({
      videos: status.videos,
      modelId: handle.modelId,
      ...(storage !== undefined && { storage }),
      ...(sandbox !== undefined && { sandbox }),
      ...(outputPath !== undefined && { path: outputPath }),
      ...(handle.jobId !== undefined && { jobId: handle.jobId }),
      sessionId: ctx.session.id,
      ...(config.limits?.maxOutputBytes !== undefined && {
        maxOutputBytes: config.limits.maxOutputBytes,
      }),
      ...(config.allowTemporaryProviderUrl !== undefined && {
        allowTemporaryProviderUrl: config.allowTemporaryProviderUrl,
      }),
      ...(status.expiresAt !== undefined && { providerExpiresAt: status.expiresAt }),
      signal: ctx.abortSignal,
    });
  } catch (error) {
    rethrowStepError(error, ctx.abortSignal);
  }

  const warnings = combineUniqueWarnings(handle.warnings, status.warnings);
  return {
    status: "completed",
    output: {
      status: "completed",
      model: handle.modelId,
      ...(handle.jobId !== undefined && { jobId: handle.jobId }),
      videos: persisted,
      ...(warnings.length > 0 && { warnings }),
    },
  };
}

export async function runCleanupStagedInputsStep(
  stagedInputKeys: readonly string[],
): Promise<void> {
  if (stagedInputKeys.length === 0) return;
  const storage = resolveConfiguredStorage(extension.config.storage);
  const deleteFn = storage?.delete;
  if (deleteFn === undefined) return;
  await Promise.allSettled(
    stagedInputKeys.map((key) =>
      deleteFn({ key, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) }),
    ),
  );
}

function rethrowStepError(error: unknown, signal: AbortSignal): never {
  if (signal.aborted || error instanceof FatalError) throw error;
  if (!isTransientProviderError(error)) {
    throw new FatalError(errorMessage(error));
  }
  throw error;
}

async function readBoundedWebhookBody(
  request: WorkflowWebhookRequest,
  maxBytes: number,
): Promise<Uint8Array | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null && declaredLength.trim().length > 0) {
    const parsed = Number(declaredLength);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      await cancelRequestBody(request);
      return null;
    }
  }
  if (request.body === null) {
    const text = await request.text();
    const bytes = new TextEncoder().encode(text);
    return bytes.byteLength > maxBytes ? null : bytes;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

async function cancelRequestBody(request: WorkflowWebhookRequest): Promise<void> {
  try {
    await request.body?.cancel();
  } catch {}
}

async function respondBestEffort(request: WorkflowWebhookRequest, status: number): Promise<void> {
  try {
    await request.respondWith(new Response(null, { status }));
  } catch {}
}

function combineUniqueWarnings(
  first: readonly string[],
  second: readonly string[],
): readonly string[] {
  const combined: string[] = [];
  for (const warning of first) {
    if (!combined.includes(warning)) combined.push(warning);
  }
  for (const warning of second) {
    if (!combined.includes(warning)) combined.push(warning);
  }
  return combined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
