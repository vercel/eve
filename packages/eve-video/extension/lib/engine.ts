import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

import {
  experimental_generateVideo,
  experimental_getVideoStatus,
  experimental_startVideo,
} from "ai";
import type { SandboxSession } from "eve/sandbox";

import {
  ASYNC_INLINE_INPUT_LIMIT_BYTES,
  DEFAULT_MAX_INPUT_BYTES,
  DEFAULT_MAX_OUTPUT_BYTES,
  assertSafePublicUrl,
  detectMediaType,
  downloadVideoBytes,
  extensionForMediaType,
  isUrlLike,
  mediaKind,
  mediaTypeFromUrl,
  normalizeAspectRatio,
  normalizeMediaType,
  normalizeResolution,
  readSandboxMedia,
  videoPath,
} from "./media.ts";
import { resolveConfiguredModel, resolveJobModel } from "./model.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import type { VideoStorage } from "./storage/types.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GenerateVideoToolProgress,
  GeneratedVideoItem,
  VideoAssetData,
  VideoExtensionConfig,
  VideoJobHandle,
  VideoJobStatus,
  VideoModelLike,
} from "./types.ts";

const DEFAULT_MAX_VIDEOS_PER_CALL = 4;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
export const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 3;

export const NO_DESTINATION_ERROR =
  'No video output destination is configured. Configure storage with vercelBlob() from "@eve/video/vercel", localDisk() from "@eve/video/storage", or a custom VideoStorage adapter; pass a sandbox "path"; or set allowTemporaryProviderUrl: true to return temporary provider URLs.';

const TRANSIENT_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
  "UND_ERR_ABORTED",
  "ERR_SOCKET_CLOSED",
  "ERR_STREAM_PREMATURE_CLOSE",
]);

type AiStartVideoOptions = Parameters<typeof experimental_startVideo>[0];
type AiGenerateVideoOptions = Parameters<typeof experimental_generateVideo>[0];
type AiVideoModel = AiGenerateVideoOptions["model"];
type AiOperation = Parameters<typeof experimental_getVideoStatus>[1]["operation"];
type AiProviderOptions = NonNullable<AiStartVideoOptions["providerOptions"]>;
type SandboxIo = Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">;

/** Options passed to {@link startVideoJob}. */
export interface StartVideoJobOptions {
  /** Optional `@eve/video` extension configuration controlling models, defaults, limits, and provider options. */
  readonly config?: VideoExtensionConfig;
  /** Video generation prompt and parameters. */
  readonly input: GenerateVideoToolInput;
  /** Optional storage adapter used to stage large local sandbox input files as public HTTPS URLs. */
  readonly storage?: VideoStorage;
  /** Optional sandbox accessor used when `input` references local sandbox media files. */
  readonly getSandbox?: () => Promise<Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">>;
  /** Optional idempotency key forwarded as the `idempotency-key` request header. */
  readonly idempotencyKey?: string;
  /** Optional HTTPS webhook URL notified by the provider when the job reaches a terminal state. */
  readonly webhookUrl?: string;
  /** Additional HTTP headers forwarded to the provider start request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional signal used to cancel job submission and media preparation. */
  readonly signal?: AbortSignal;
}

/** Options passed to {@link checkVideoJob}. */
export interface CheckVideoJobOptions {
  /** Optional `@eve/video` extension configuration used to resolve the model and gateway settings. */
  readonly config?: VideoExtensionConfig;
  /** Model ID or configured catalog alias that started the asynchronous job. */
  readonly modelId: string;
  /** Opaque operation handle previously returned by {@link startVideoJob}. */
  readonly operation: unknown;
  /** Additional HTTP headers forwarded to the provider status request. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional signal used to cancel the status request. */
  readonly signal?: AbortSignal;
  /** Maximum number of AI SDK retries for the status request. Set to `0` when an outer workflow manages retries. */
  readonly maxRetries?: number;
}

/** Options passed to {@link persistVideos}. */
export interface PersistVideosOptions {
  /** Raw video assets returned by a video model. */
  readonly videos: readonly VideoAssetData[];
  /** Resolved model ID recorded in storage metadata. */
  readonly modelId: string;
  /** Optional external storage adapter for persisting generated videos. */
  readonly storage?: VideoStorage;
  /** Optional sandbox session for writing generated videos to {@link path}. */
  readonly sandbox?: Pick<SandboxSession, "writeBinaryFile">;
  /** Optional sandbox file path where generated videos are written. */
  readonly path?: string;
  /** Optional provider job identifier recorded in storage metadata. */
  readonly jobId?: string;
  /** Optional eve session identifier recorded in storage metadata. */
  readonly sessionId?: string;
  /** Maximum permitted download size in bytes for each video. Defaults to 512 MiB. */
  readonly maxOutputBytes?: number;
  /** Whether to pass through temporary provider URLs when neither storage nor a sandbox path is configured. */
  readonly allowTemporaryProviderUrl?: boolean;
  /** ISO 8601 expiration timestamp reported by the provider for temporary video URLs. */
  readonly providerExpiresAt?: string;
  /** Optional signal used to cancel downloads and writes. */
  readonly signal?: AbortSignal;
  /** Optional custom `fetch` implementation used when downloading remote provider video URLs. */
  readonly fetch?: typeof fetch;
}

/** Options passed to {@link generateVideos}. */
export interface GenerateVideosOptions {
  /** Optional `@eve/video` extension configuration controlling models, storage, polling, defaults, and limits. */
  readonly config?: VideoExtensionConfig;
  /** Video generation prompt and parameters. */
  readonly input: GenerateVideoToolInput;
  /** Optional sandbox accessor used when reading local input files or writing to `input.path`. */
  readonly getSandbox?: () => Promise<Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">>;
  /** Optional eve session identifier recorded in storage metadata. */
  readonly sessionId?: string;
  /** Optional idempotency key forwarded as the `idempotency-key` header on job submission. */
  readonly idempotencyKey?: string;
  /** Additional HTTP headers forwarded to provider requests. */
  readonly headers?: Readonly<Record<string, string>>;
  /** Optional signal used to cancel generation, polling, downloads, and persistence. */
  readonly signal?: AbortSignal;
  /** Optional custom `fetch` implementation used when downloading generated video URLs. */
  readonly fetch?: typeof fetch;
}

interface PreparedParameters {
  readonly prompt: string;
  readonly n: number;
  readonly duration?: number;
  readonly aspectRatio?: `${number}:${number}` | "adaptive";
  readonly resolution?: `${number}x${number}`;
  readonly generateAudio?: boolean;
  readonly fps?: number;
  readonly seed?: number;
  readonly path?: string;
  readonly maxInputBytes: number;
  readonly maxOutputBytes: number;
}

interface ResolvedMediaEntry {
  readonly slot: string;
  readonly frameType?: "first_frame" | "last_frame";
  url?: string;
  data?: Uint8Array;
  mediaType?: string;
}

interface ResolvedInputMedia {
  readonly frames: readonly ResolvedMediaEntry[];
  readonly references: readonly ResolvedMediaEntry[];
  readonly frameImages?: AiStartVideoOptions["frameImages"];
  readonly inputReferences?: AiStartVideoOptions["inputReferences"];
  readonly stagedKeys: readonly string[];
}

/** Starts an asynchronous video generation job and returns an opaque handle for status polling. */
export async function startVideoJob(options: StartVideoJobOptions): Promise<VideoJobHandle> {
  const webhookUrl =
    options.webhookUrl !== undefined
      ? (await assertSafePublicUrl(options.webhookUrl, { resolveDns: false })).href
      : undefined;
  const ctx = await prepareJobContext({
    ...options,
    requireAsync: true,
    requireDestination: false,
  });
  try {
    const result = await experimental_startVideo(
      buildSdkCallOptions({
        model: ctx.model,
        params: ctx.params,
        media: ctx.media,
        providerOptions: ctx.config.providerOptions,
        headers: buildRequestHeaders(options.headers, options.idempotencyKey),
        webhookUrl,
        signal: ctx.signal,
      }),
    );
    const asyncJob = extractGatewayAsyncJob(result.providerMetadata);
    const jobId = readNonEmptyString(asyncJob?.jobId);
    const webhookSigningSecret = readNonEmptyString(asyncJob?.webhookSigningSecret);
    return {
      modelId: ctx.modelId,
      operation: result.operation,
      ...(jobId !== undefined && { jobId }),
      ...(webhookSigningSecret !== undefined && { webhookSigningSecret }),
      ...(ctx.media.stagedKeys.length > 0 && { stagedInputKeys: ctx.media.stagedKeys }),
      warnings: formatWarnings(result.warnings),
    };
  } catch (error) {
    await cleanupStoredKeys(ctx.storage, ctx.media.stagedKeys);
    throw error;
  }
}

/** Checks the current status of an asynchronous video generation job started with {@link startVideoJob}. */
export async function checkVideoJob(options: CheckVideoJobOptions): Promise<VideoJobStatus> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const { modelId, model } = resolveJobModel(options.config ?? {}, options.modelId);
  if (typeof model.doStatus !== "function") {
    throw new Error(`Video model "${modelId}" does not support asynchronous status checks.`);
  }
  const headers = buildRequestHeaders(options.headers);
  const result = await experimental_getVideoStatus(toAiVideoModel(model), {
    operation: options.operation as AiOperation,
    abortSignal: signal,
    ...(headers !== undefined && { headers }),
    ...(options.maxRetries !== undefined && { maxRetries: options.maxRetries }),
  });
  if (result.status === "pending") {
    return { status: "pending", warnings: formatWarnings(result.warnings) };
  }
  if (result.status === "error") {
    return { status: "error", error: result.error || "Video generation failed." };
  }
  const expiresAt = extractGatewayExpiresAt(result.providerMetadata);
  return {
    status: "completed",
    videos: result.videos.map((v) => ({ ...v })),
    warnings: formatWarnings(result.warnings),
    ...(expiresAt !== undefined && { expiresAt }),
  };
}

/** Downloads, validates, and persists generated video assets to configured storage and/or a sandbox path. */
export async function persistVideos(
  options: PersistVideosOptions,
): Promise<readonly GeneratedVideoItem[]> {
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  if (options.videos.length === 0) throw new Error("The video model returned no videos.");

  const sandboxPath = normalizeOptionalPath(options.path);
  if (sandboxPath !== undefined && options.sandbox === undefined) {
    throw new Error('Cannot write generated video to "path" without a sandbox instance.');
  }
  const hasSandbox = options.sandbox !== undefined && sandboxPath !== undefined;
  if (options.storage === undefined && !hasSandbox && options.allowTemporaryProviderUrl !== true) {
    throw new Error(NO_DESTINATION_ERROR);
  }
  const maxOutputBytes = assertPositive(
    options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "maxOutputBytes limit",
  );
  const baseId = `vid_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const dateStamp = new Date().toISOString().slice(0, 10);
  const storedKeys: string[] = [];
  const items: GeneratedVideoItem[] = [];

  try {
    for (let i = 0; i < options.videos.length; i += 1) {
      signal.throwIfAborted();
      const video = options.videos[i];
      if (video.type === "uploaded") {
        items.push({ mediaType: usableMediaType(video.mediaType) ?? "video/mp4", bytes: 0 });
        continue;
      }
      if (options.storage === undefined && !hasSandbox && options.allowTemporaryProviderUrl) {
        if (video.type !== "url") {
          throw new Error(
            'The video model returned video bytes without a provider URL, and neither storage nor a sandbox "path" is configured. Configure video storage or pass a sandbox "path".',
          );
        }
        const safeUrl = await assertSafePublicUrl(video.url, { resolveDns: false });
        items.push({
          url: safeUrl.href,
          mediaType:
            usableMediaType(video.mediaType) ?? mediaTypeFromUrl(safeUrl.href) ?? "video/mp4",
          bytes: 0,
          temporary: true,
          ...(options.providerExpiresAt !== undefined && { expiresAt: options.providerExpiresAt }),
        });
        continue;
      }

      const { bytes, downloadedMediaType } = await resolveVideoBytes(
        video,
        maxOutputBytes,
        signal,
        options.fetch,
      );
      if (bytes.byteLength === 0)
        throw new Error("The video model returned an empty video payload.");
      if (bytes.byteLength > maxOutputBytes) {
        throw new Error(
          `Generated video (${bytes.byteLength} bytes) exceeds maximum allowed size of ${maxOutputBytes} bytes.`,
        );
      }
      const mediaType =
        usableMediaType(video.mediaType) ??
        usableMediaType(downloadedMediaType) ??
        detectMediaType(bytes) ??
        "video/mp4";

      let storageFields: Partial<GeneratedVideoItem> = {};
      if (options.storage !== undefined) {
        const filename = `${baseId}${i === 0 ? "" : `-${i}`}${extensionForMediaType(mediaType)}`;
        const stored = await options.storage.put({
          key: `videos/${dateStamp}/${filename}`,
          data: bytes,
          mediaType,
          filename,
          metadata: {
            model: options.modelId,
            ...(options.jobId !== undefined && { jobId: options.jobId }),
            ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
          },
          signal,
        });
        storedKeys.push(stored.key);
        storageFields = {
          storageKey: stored.key,
          mediaType: usableMediaType(stored.mediaType) ?? mediaType,
          bytes: stored.bytes,
          ...(stored.url !== undefined && { url: stored.url }),
          ...(stored.downloadUrl !== undefined && { downloadUrl: stored.downloadUrl }),
          ...(stored.path !== undefined && { storagePath: stored.path }),
          ...(stored.visibility !== undefined && { visibility: stored.visibility }),
          ...(stored.expiresAt !== undefined && { expiresAt: stored.expiresAt }),
        };
      }
      let writtenPath: string | undefined;
      if (options.sandbox !== undefined && sandboxPath !== undefined) {
        writtenPath = videoPath(sandboxPath, i);
        await options.sandbox.writeBinaryFile({ path: writtenPath, content: bytes, signal });
      }
      items.push({
        mediaType,
        bytes: bytes.byteLength,
        ...storageFields,
        ...(writtenPath !== undefined && { path: writtenPath }),
      });
    }
  } catch (error) {
    await cleanupStoredKeys(options.storage, storedKeys);
    throw error;
  }
  return items;
}

/** Runs end-to-end video generation, yielding progress updates and returning persisted video metadata. */
export async function* generateVideos(
  options: GenerateVideosOptions,
): AsyncGenerator<GenerateVideoToolProgress, GenerateVideoToolOutput, void> {
  const intervalMs = options.config?.poll?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = options.config?.poll?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
  if (!Number.isFinite(intervalMs) || intervalMs < 0) {
    throw new Error(`Invalid poll.intervalMs: ${intervalMs}.`);
  }
  assertPositive(timeoutMs, "poll.timeoutMs");

  const ctx = await prepareJobContext({
    ...options,
    requireAsync: false,
    requireDestination: true,
  });
  const { config, signal, params, modelId, model, supportsAsync, storage, sandbox, media } = ctx;
  const warnings: string[] = [];
  let jobId: string | undefined;
  let assets: readonly VideoAssetData[];
  let providerExpiresAt: string | undefined;

  try {
    const startHeaders = buildRequestHeaders(options.headers, options.idempotencyKey);
    const statusHeaders = buildRequestHeaders(options.headers);

    if (supportsAsync) {
      yield { status: "starting", model: modelId };
      const startResult = await experimental_startVideo(
        buildSdkCallOptions({
          model,
          params,
          media,
          providerOptions: config.providerOptions,
          headers: startHeaders,
          signal,
        }),
      );
      jobId = readNonEmptyString(extractGatewayAsyncJob(startResult.providerMetadata)?.jobId);
      appendUniqueWarnings(warnings, formatWarnings(startResult.warnings));

      const polled = yield* pollAsyncJob({
        model,
        modelId,
        operation: startResult.operation,
        jobId,
        intervalMs,
        timeoutMs,
        statusHeaders,
        warnings,
        signal,
      });
      assets = polled.videos;
      providerExpiresAt = polled.expiresAt;
    } else {
      yield { status: "generating", model: modelId, elapsedSeconds: 0, attempt: 1 };
      if (storage === undefined && params.path === undefined && config.allowTemporaryProviderUrl) {
        const direct = await generateDirectDoGenerate({
          model,
          params,
          media,
          providerOptions: config.providerOptions,
          headers: startHeaders,
          signal,
        });
        appendUniqueWarnings(warnings, direct.warnings);
        assets = direct.videos;
        providerExpiresAt = direct.expiresAt;
      } else {
        const result = await experimental_generateVideo({
          ...buildSdkCallOptions({
            model,
            params,
            media,
            providerOptions: config.providerOptions,
            headers: startHeaders,
            signal,
          }),
          download: async ({ url, abortSignal }) =>
            downloadVideoBytes(url.href, {
              maxBytes: params.maxOutputBytes,
              signal: abortSignal ?? signal,
              ...(options.fetch !== undefined && { fetch: options.fetch }),
            }),
        });
        appendUniqueWarnings(warnings, formatWarnings(result.warnings));
        assets = [
          ...result.videos.map((file) => ({
            type: "binary" as const,
            data: file.uint8Array,
            mediaType: file.mediaType,
          })),
          ...Array.from({ length: result.uploadedVideos }, () => ({
            type: "uploaded" as const,
            mediaType: "video/mp4",
          })),
        ];
      }
    }

    yield {
      status: "saving",
      model: modelId,
      ...(jobId !== undefined && { jobId }),
      videoCount: assets.length,
    };
    const persisted = await persistVideos({
      videos: assets,
      modelId,
      maxOutputBytes: params.maxOutputBytes,
      signal,
      ...(storage !== undefined && { storage }),
      ...(sandbox !== undefined && { sandbox }),
      ...(params.path !== undefined && { path: params.path }),
      ...(jobId !== undefined && { jobId }),
      ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      ...(config.allowTemporaryProviderUrl !== undefined && {
        allowTemporaryProviderUrl: config.allowTemporaryProviderUrl,
      }),
      ...(providerExpiresAt !== undefined && { providerExpiresAt }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
    return {
      status: "completed",
      model: modelId,
      ...(jobId !== undefined && { jobId }),
      videos: persisted,
      ...(warnings.length > 0 && { warnings }),
    };
  } finally {
    await cleanupStoredKeys(storage, media.stagedKeys);
  }
}

async function* pollAsyncJob(options: {
  readonly model: VideoModelLike;
  readonly modelId: string;
  readonly operation: unknown;
  readonly jobId?: string;
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly statusHeaders?: Record<string, string>;
  readonly warnings: string[];
  readonly signal: AbortSignal;
}): AsyncGenerator<
  GenerateVideoToolProgress,
  { readonly videos: readonly VideoAssetData[]; readonly expiresAt?: string },
  void
> {
  const { model, modelId, jobId, intervalMs, timeoutMs, statusHeaders, warnings, signal } = options;
  const startedAt = Date.now();
  let attempt = 0;
  let consecutiveErrors = 0;

  for (;;) {
    signal.throwIfAborted();
    const elapsedMs = Date.now() - startedAt;
    if (attempt > 0 && elapsedMs >= timeoutMs) throw createTimeoutError(modelId, timeoutMs, jobId);
    attempt += 1;
    yield {
      status: "generating",
      model: modelId,
      ...(jobId !== undefined && { jobId }),
      elapsedSeconds: Math.floor(elapsedMs / 1000),
      attempt,
    };

    const remainingBeforeSleep = timeoutMs - (Date.now() - startedAt);
    if (attempt > 1 && remainingBeforeSleep <= 0)
      throw createTimeoutError(modelId, timeoutMs, jobId);
    const sleepMs =
      attempt === 1 && intervalMs >= timeoutMs
        ? Math.min(intervalMs, Math.floor(timeoutMs / 2))
        : Math.min(intervalMs, remainingBeforeSleep);
    if (sleepMs > 0) await delay(sleepMs, undefined, { signal });
    if (attempt > 1 && Date.now() - startedAt >= timeoutMs) {
      throw createTimeoutError(modelId, timeoutMs, jobId);
    }

    const pollRemainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
    const timeoutError = createTimeoutError(modelId, timeoutMs, jobId);
    const timeoutController = new AbortController();
    const timer = setTimeout(() => timeoutController.abort(timeoutError), pollRemainingMs);

    let statusResult: Awaited<ReturnType<typeof experimental_getVideoStatus>>;
    try {
      const statusPromise = experimental_getVideoStatus(toAiVideoModel(model), {
        operation: options.operation as AiOperation,
        abortSignal: AbortSignal.any([signal, timeoutController.signal]),
        maxRetries: 0,
        ...(statusHeaders !== undefined && { headers: statusHeaders }),
      });
      void statusPromise.catch(() => undefined);
      const timeoutPromise = new Promise<never>((_resolve, reject) => {
        timeoutController.signal.addEventListener("abort", () => reject(timeoutError), {
          once: true,
        });
      });
      statusResult = await Promise.race([statusPromise, timeoutPromise]);
      consecutiveErrors = 0;
    } catch (error) {
      if (signal.aborted) throw error;
      if (timeoutController.signal.aborted) throw timeoutError;
      if (!isTransientPollError(error) || ++consecutiveErrors > MAX_CONSECUTIVE_POLL_ERRORS) {
        throw error;
      }
      continue;
    } finally {
      clearTimeout(timer);
    }

    if ("warnings" in statusResult && statusResult.warnings !== undefined) {
      appendUniqueWarnings(warnings, formatWarnings(statusResult.warnings));
    }
    if (statusResult.status === "error") {
      throw new Error(statusResult.error || "Video generation failed.");
    }
    if (statusResult.status === "completed") {
      const expiresAt = extractGatewayExpiresAt(statusResult.providerMetadata);
      return {
        videos: statusResult.videos.map((v) => ({ ...v })),
        ...(expiresAt !== undefined && { expiresAt }),
      };
    }
    if (Date.now() - startedAt >= timeoutMs) throw createTimeoutError(modelId, timeoutMs, jobId);
  }
}

async function prepareJobContext(options: {
  readonly config?: VideoExtensionConfig;
  readonly input: GenerateVideoToolInput;
  readonly storage?: VideoStorage;
  readonly getSandbox?: () => Promise<SandboxIo>;
  readonly signal?: AbortSignal;
  readonly requireAsync: boolean;
  readonly requireDestination: boolean;
}) {
  const config = options.config ?? {};
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const params = prepareGenerationParameters(config, options.input);
  const { modelId, model } = resolveConfiguredModel(config, options.input.model);
  const supportsAsync = typeof model.doStart === "function" && typeof model.doStatus === "function";
  if (options.requireAsync && !supportsAsync) {
    throw new Error(
      `Video model "${modelId}" does not support asynchronous start/status jobs. Use generateVideos() instead.`,
    );
  }
  if (!supportsAsync && typeof model.doGenerate !== "function") {
    throw new Error(`Video model "${modelId}" does not implement doGenerate or doStart/doStatus.`);
  }
  if (supportsAsync) {
    const modelMax = await resolveModelMaxVideosPerCall(model);
    if (modelMax !== undefined && params.n > modelMax) {
      throw new Error(
        `Video model "${modelId}" supports at most ${modelMax} video(s) per async call, but ${params.n} were requested.`,
      );
    }
  }

  const storage = options.storage ?? resolveConfiguredStorage(config.storage);
  if (
    options.requireDestination &&
    storage === undefined &&
    params.path === undefined &&
    config.allowTemporaryProviderUrl !== true
  ) {
    throw new Error(NO_DESTINATION_ERROR);
  }

  const forOutput = options.requireDestination && params.path !== undefined;
  const forInput =
    (options.input.start !== undefined && !isUrlLike(options.input.start)) ||
    (options.input.end !== undefined && !isUrlLike(options.input.end)) ||
    (options.input.references?.some((ref) => !isUrlLike(ref)) ?? false);
  const sandbox =
    forOutput || forInput
      ? await acquireSandbox(options.getSandbox, { forInput, forOutput, signal })
      : undefined;
  const media = await resolveInputMedia({
    input: options.input,
    sandbox,
    storage,
    maxInputBytes: params.maxInputBytes,
    stageLargeInputs: supportsAsync,
    signal,
  });

  return { config, signal, params, modelId, model, supportsAsync, storage, sandbox, media };
}

async function generateDirectDoGenerate(options: {
  readonly model: VideoModelLike;
  readonly params: PreparedParameters;
  readonly media: ResolvedInputMedia;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly headers?: Record<string, string>;
  readonly signal: AbortSignal;
}): Promise<{
  readonly videos: readonly VideoAssetData[];
  readonly warnings: readonly string[];
  readonly expiresAt?: string;
}> {
  const doGenerate = options.model.doGenerate;
  if (typeof doGenerate !== "function") {
    throw new Error(`Video model "${options.model.modelId}" does not implement doGenerate.`);
  }
  const toFile = (entry: ResolvedMediaEntry) =>
    entry.url !== undefined
      ? {
          type: "url",
          url: entry.url,
          ...(entry.mediaType !== undefined && { mediaType: entry.mediaType }),
        }
      : { type: "file", data: entry.data, mediaType: entry.mediaType ?? "image/png" };

  const warnings: string[] = [];
  const frameImages =
    options.media.frames.length > 0
      ? options.media.frames.map((f) => ({
          image: toFile(f),
          frameType: f.frameType ?? "first_frame",
        }))
      : undefined;
  const firstFrame = frameImages?.find((f) => f.frameType === "first_frame")?.image;
  const inputReferences =
    frameImages !== undefined
      ? undefined
      : options.media.references.length > 0
        ? options.media.references.map(toFile)
        : undefined;
  if (frameImages !== undefined && options.media.references.length > 0) {
    warnings.push(
      "inputReferences were ignored because frameImages were provided; frameImages and inputReferences cannot be combined.",
    );
  }

  const perCall = (await resolveModelMaxVideosPerCall(options.model)) ?? 1;
  const videos: VideoAssetData[] = [];
  let expiresAt: string | undefined;
  for (let remaining = options.params.n; remaining > 0; remaining -= perCall) {
    const rawResult = await doGenerate.call(options.model, {
      prompt: options.params.prompt,
      n: Math.min(remaining, perCall),
      aspectRatio: options.params.aspectRatio,
      resolution: options.params.resolution,
      duration: options.params.duration,
      fps: options.params.fps,
      seed: options.params.seed,
      image: firstFrame,
      frameImages,
      inputReferences,
      generateAudio: options.params.generateAudio,
      providerOptions:
        options.providerOptions !== undefined ? toAiProviderOptions(options.providerOptions) : {},
      ...(options.headers !== undefined && { headers: options.headers }),
      abortSignal: options.signal,
    });
    const record = asRecord(rawResult);
    if (record === undefined || !Array.isArray(record.videos)) {
      throw new Error(`Video model "${options.model.modelId}" returned an invalid result.`);
    }
    videos.push(...(record.videos as readonly VideoAssetData[]).map((v) => ({ ...v })));
    if (Array.isArray(record.warnings))
      appendUniqueWarnings(warnings, formatWarnings(record.warnings));
    expiresAt ??= extractGatewayExpiresAt(record.providerMetadata);
  }
  return { videos, warnings, ...(expiresAt !== undefined && { expiresAt }) };
}

async function resolveVideoBytes(
  video: Exclude<VideoAssetData, { readonly type: "uploaded" }>,
  maxOutputBytes: number,
  signal: AbortSignal,
  fetchImpl?: typeof fetch,
): Promise<{ readonly bytes: Uint8Array; readonly downloadedMediaType?: string }> {
  if (video.type === "url") {
    const { data, mediaType } = await downloadVideoBytes(video.url, {
      maxBytes: maxOutputBytes,
      signal,
      ...(fetchImpl !== undefined && { fetch: fetchImpl }),
    });
    return { bytes: data, downloadedMediaType: mediaType };
  }
  if (video.type === "base64") {
    const compact = video.data.replace(/\s+/g, "");
    const padding = compact.endsWith("==") ? 2 : compact.endsWith("=") ? 1 : 0;
    const estimated = Math.floor((compact.length * 3) / 4) - padding;
    if (estimated > maxOutputBytes) {
      throw new Error(
        `Generated video (${estimated} bytes) exceeds maximum allowed size of ${maxOutputBytes} bytes.`,
      );
    }
    const buf = Buffer.from(compact, "base64");
    return { bytes: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength) };
  }
  return { bytes: video.data };
}

function prepareGenerationParameters(
  config: VideoExtensionConfig,
  input: GenerateVideoToolInput,
): PreparedParameters {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new Error("Video prompt must be a non-empty string.");

  const n = assertPositiveInt(input.n ?? 1, 'video count "n"');
  const maxVideosPerCall = assertPositiveInt(
    config.limits?.maxVideosPerCall ?? DEFAULT_MAX_VIDEOS_PER_CALL,
    "limits.maxVideosPerCall",
  );
  if (n > maxVideosPerCall) {
    throw new Error(
      `Requested ${n} videos, which exceeds the configured maximum of ${maxVideosPerCall} videos per call.`,
    );
  }
  if (input.start !== undefined && input.start.trim().length === 0) {
    throw new Error('Input "start" must be a non-empty URL or sandbox file path.');
  }
  if (input.end !== undefined && input.end.trim().length === 0) {
    throw new Error('Input "end" must be a non-empty URL or sandbox file path.');
  }
  if (input.references?.some((ref) => ref.trim().length === 0)) {
    throw new Error('Each entry in "references" must be a non-empty URL or sandbox file path.');
  }

  const maxDurationSeconds = config.limits?.maxDurationSeconds;
  if (maxDurationSeconds !== undefined)
    assertPositive(maxDurationSeconds, "limits.maxDurationSeconds");
  const duration = input.duration ?? config.defaults?.duration;
  if (duration !== undefined) {
    assertPositive(duration, "video duration");
    if (maxDurationSeconds !== undefined && duration > maxDurationSeconds) {
      throw new Error(
        `Requested video duration ${duration}s exceeds the configured maximum of ${maxDurationSeconds}s.`,
      );
    }
  }

  const rawAspectRatio = input.aspectRatio ?? config.defaults?.aspectRatio;
  const aspectRatio =
    rawAspectRatio !== undefined ? normalizeAspectRatio(rawAspectRatio) : undefined;
  const rawResolution = input.resolution ?? config.defaults?.resolution;
  const resolution =
    rawResolution !== undefined ? normalizeResolution(rawResolution, aspectRatio) : undefined;
  const generateAudio = input.audio ?? config.defaults?.audio;
  const fps = input.fps ?? config.defaults?.fps;
  if (fps !== undefined) assertPositive(fps, "video fps");
  if (input.seed !== undefined && !Number.isInteger(input.seed)) {
    throw new Error(`Invalid video seed: expected an integer, received ${input.seed}.`);
  }

  const path = normalizeOptionalPath(input.path);
  const maxInputBytes = assertPositive(
    config.limits?.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
    "limits.maxInputBytes",
  );
  const maxOutputBytes = assertPositive(
    config.limits?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    "limits.maxOutputBytes",
  );

  return {
    prompt,
    n,
    maxInputBytes,
    maxOutputBytes,
    ...(duration !== undefined && { duration }),
    ...(aspectRatio !== undefined && { aspectRatio }),
    ...(resolution !== undefined && { resolution }),
    ...(generateAudio !== undefined && { generateAudio }),
    ...(fps !== undefined && { fps }),
    ...(input.seed !== undefined && { seed: input.seed }),
    ...(path !== undefined && { path }),
  };
}

async function resolveInputMedia(options: {
  readonly input: GenerateVideoToolInput;
  readonly sandbox?: SandboxIo;
  readonly storage?: VideoStorage;
  readonly maxInputBytes: number;
  readonly stageLargeInputs: boolean;
  readonly signal: AbortSignal;
}): Promise<ResolvedInputMedia> {
  const frameSpecs: readonly (readonly [string, "first_frame" | "last_frame", string])[] = [
    ...(options.input.start !== undefined
      ? ([["start", "first_frame", options.input.start]] as const)
      : []),
    ...(options.input.end !== undefined
      ? ([["end", "last_frame", options.input.end]] as const)
      : []),
  ];
  const frames: ResolvedMediaEntry[] = [];
  for (const [slot, frameType, raw] of frameSpecs) {
    frames.push(
      await resolveMediaEntry({
        raw,
        slot,
        frameType,
        allowedKinds: ["image"],
        sandbox: options.sandbox,
        maxInputBytes: options.maxInputBytes,
        signal: options.signal,
      }),
    );
  }
  const references: ResolvedMediaEntry[] = [];
  for (let i = 0; i < (options.input.references?.length ?? 0); i += 1) {
    references.push(
      await resolveMediaEntry({
        raw: options.input.references![i],
        slot: `ref-${i}`,
        allowedKinds: ["image", "video", "audio"],
        sandbox: options.sandbox,
        maxInputBytes: options.maxInputBytes,
        signal: options.signal,
      }),
    );
  }

  const stagedKeys: string[] = [];
  const localEntries = [...frames, ...references].filter(
    (entry) => entry.data !== undefined && entry.mediaType !== undefined,
  );
  let remainingInlineBytes = localEntries.reduce((sum, e) => sum + (e.data?.byteLength ?? 0), 0);

  if (
    options.stageLargeInputs &&
    options.storage !== undefined &&
    remainingInlineBytes > ASYNC_INLINE_INPUT_LIMIT_BYTES
  ) {
    localEntries.sort((a, b) => (b.data?.byteLength ?? 0) - (a.data?.byteLength ?? 0));
    const prefix = `inputs/${new Date().toISOString().slice(0, 10)}/vid_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
    try {
      for (const entry of localEntries) {
        if (remainingInlineBytes <= ASYNC_INLINE_INPUT_LIMIT_BYTES) break;
        if (entry.data === undefined || entry.mediaType === undefined) continue;
        const filename = `${entry.slot}${extensionForMediaType(entry.mediaType)}`;
        const stored = await options.storage.put({
          key: `${prefix}/${filename}`,
          data: entry.data,
          mediaType: entry.mediaType,
          filename,
          ttlDays: 1,
          signal: options.signal,
        });
        let safeUrl: URL | undefined;
        if (stored.url !== undefined && stored.visibility !== "private") {
          safeUrl = await assertSafePublicUrl(stored.url, { resolveDns: false }).catch(
            () => undefined,
          );
        }
        if (safeUrl !== undefined) {
          stagedKeys.push(stored.key);
          remainingInlineBytes -= entry.data.byteLength;
          entry.url = safeUrl.href;
          entry.data = undefined;
        } else {
          await cleanupStoredKeys(options.storage, [stored.key]);
          break;
        }
      }
    } catch (error) {
      await cleanupStoredKeys(options.storage, stagedKeys);
      throw error;
    }
  }

  return {
    frames,
    references,
    stagedKeys,
    ...(frames.length > 0 && {
      frameImages: frames.map((f) => ({
        image: f.url ?? (f.data as Uint8Array),
        frameType: f.frameType ?? "first_frame",
      })),
    }),
    ...(references.length > 0 && {
      inputReferences: references.map((r) =>
        r.url !== undefined
          ? r.mediaType !== undefined
            ? { data: r.url, mediaType: r.mediaType }
            : r.url
          : {
              data: r.data as Uint8Array,
              ...(r.mediaType !== undefined && { mediaType: r.mediaType }),
            },
      ),
    }),
  };
}

async function resolveMediaEntry(options: {
  readonly raw: string;
  readonly slot: string;
  readonly frameType?: "first_frame" | "last_frame";
  readonly allowedKinds: readonly ("image" | "video" | "audio")[];
  readonly sandbox?: SandboxIo;
  readonly maxInputBytes: number;
  readonly signal: AbortSignal;
}): Promise<ResolvedMediaEntry> {
  const trimmed = options.raw.trim();
  if (trimmed.length === 0) {
    throw new Error(`Input "${options.slot}" must be a non-empty URL or sandbox file path.`);
  }
  if (isUrlLike(trimmed)) {
    const safeUrl = await assertSafePublicUrl(trimmed, { resolveDns: false });
    const inferred = mediaTypeFromUrl(safeUrl.href);
    if (inferred !== undefined) {
      const kind = mediaKind(inferred);
      if (kind === "other" || !options.allowedKinds.includes(kind)) {
        throw new Error(
          `Unsupported media type "${inferred}" for "${options.slot}" URL "${trimmed}". Expected ${options.allowedKinds.join(" or ")}.`,
        );
      }
    }
    return {
      slot: options.slot,
      url: safeUrl.href,
      ...(options.frameType !== undefined && { frameType: options.frameType }),
      ...(inferred !== undefined && { mediaType: inferred }),
    };
  }
  if (options.sandbox === undefined) {
    throw new Error(missingSandboxMessage({ forInput: true, forOutput: false }));
  }
  const file = await readSandboxMedia(options.sandbox, trimmed, {
    maxBytes: options.maxInputBytes,
    allowedKinds: options.allowedKinds,
    signal: options.signal,
  });
  return {
    slot: options.slot,
    data: file.data,
    mediaType: file.mediaType,
    ...(options.frameType !== undefined && { frameType: options.frameType }),
  };
}

function buildSdkCallOptions(options: {
  readonly model: VideoModelLike;
  readonly params: PreparedParameters;
  readonly media: ResolvedInputMedia;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  readonly headers?: Record<string, string>;
  readonly webhookUrl?: string;
  readonly signal: AbortSignal;
}): AiStartVideoOptions {
  return {
    model: toAiVideoModel(options.model),
    prompt: options.params.prompt,
    n: options.params.n,
    abortSignal: options.signal,
    ...(options.params.duration !== undefined && { duration: options.params.duration }),
    ...(options.params.aspectRatio !== undefined && { aspectRatio: options.params.aspectRatio }),
    ...(options.params.resolution !== undefined && { resolution: options.params.resolution }),
    ...(options.params.generateAudio !== undefined && {
      generateAudio: options.params.generateAudio,
    }),
    ...(options.params.fps !== undefined && { fps: options.params.fps }),
    ...(options.params.seed !== undefined && { seed: options.params.seed }),
    ...(options.media.frameImages !== undefined && { frameImages: options.media.frameImages }),
    ...(options.media.inputReferences !== undefined && {
      inputReferences: options.media.inputReferences,
    }),
    ...(options.providerOptions !== undefined && {
      providerOptions: toAiProviderOptions(options.providerOptions),
    }),
    ...(options.headers !== undefined && { headers: options.headers }),
    ...(options.webhookUrl !== undefined && { webhookUrl: options.webhookUrl }),
  };
}

async function resolveModelMaxVideosPerCall(model: VideoModelLike): Promise<number | undefined> {
  const raw =
    typeof model.maxVideosPerCall === "function"
      ? await model.maxVideosPerCall({ modelId: model.modelId })
      : model.maxVideosPerCall;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 ? raw : undefined;
}

function toAiVideoModel(model: VideoModelLike): AiVideoModel {
  const candidate: object = model;
  return candidate as AiVideoModel;
}

function toAiProviderOptions(
  providerOptions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): AiProviderOptions {
  const cloned: Record<string, object> = {};
  for (const [provider, values] of Object.entries(providerOptions)) {
    cloned[provider] = { ...values };
  }
  return cloned as AiProviderOptions;
}

function buildRequestHeaders(
  headers?: Readonly<Record<string, string>>,
  idempotencyKey?: string,
): Record<string, string> | undefined {
  const result: Record<string, string> = headers !== undefined ? { ...headers } : {};
  const trimmedKey = idempotencyKey?.trim();
  if (
    trimmedKey !== undefined &&
    trimmedKey.length > 0 &&
    !Object.keys(result).some((k) => k.toLowerCase() === "idempotency-key")
  ) {
    result["idempotency-key"] = trimmedKey;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function assertPositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid ${label}: expected a positive number, received ${value}.`);
  }
  return value;
}

function assertPositiveInt(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`Invalid ${label}: expected a positive integer, received ${value}.`);
  }
  return value;
}

export function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (trimmed.length === 0) throw new Error('Sandbox output "path" must be a non-empty string.');
  return trimmed;
}

async function acquireSandbox(
  getSandbox: (() => Promise<SandboxIo>) | undefined,
  usage: { readonly forInput: boolean; readonly forOutput: boolean; readonly signal: AbortSignal },
): Promise<SandboxIo> {
  if (getSandbox === undefined) throw new Error(missingSandboxMessage(usage));
  try {
    return await getSandbox();
  } catch (error) {
    if (usage.signal.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${missingSandboxMessage(usage)} (${detail})`, { cause: error });
  }
}

function missingSandboxMessage(usage: {
  readonly forInput: boolean;
  readonly forOutput: boolean;
}): string {
  if (usage.forInput && usage.forOutput) {
    return 'A sandbox is required to read local input media files and write generated videos to "path". Configure a sandbox on the agent, or pass https:// URLs for inputs and omit "path".';
  }
  if (usage.forOutput) {
    return 'Writing generated videos to "path" requires an agent sandbox. Configure a sandbox on the agent, or omit "path" and use configured video storage.';
  }
  return "Reading local input media files requires an agent sandbox. Configure a sandbox on the agent, or pass https:// URLs instead of file paths.";
}

function formatWarnings(warnings: readonly unknown[] | undefined): string[] {
  if (warnings === undefined || warnings.length === 0) return [];
  const formatted: string[] = [];
  for (const warning of warnings) {
    const text = formatWarning(warning);
    if (text.length > 0 && !formatted.includes(text)) formatted.push(text);
  }
  return formatted;
}

function formatWarning(warning: unknown): string {
  if (typeof warning === "string") return warning.trim();
  const record = asRecord(warning);
  if (record === undefined) return String(warning);
  if (record.type === "unsupported") {
    const feature = typeof record.feature === "string" ? record.feature : "feature";
    const details = readNonEmptyString(record.details);
    return details !== undefined ? `Unsupported ${feature}: ${details}` : `Unsupported ${feature}`;
  }
  if (record.type === "compatibility") {
    const feature = typeof record.feature === "string" ? record.feature : "feature";
    const details = readNonEmptyString(record.details);
    return details !== undefined
      ? `Compatibility (${feature}): ${details}`
      : `Compatibility warning for ${feature}`;
  }
  if (record.type === "deprecated") {
    const setting = typeof record.setting === "string" ? record.setting : "setting";
    const message = readNonEmptyString(record.message);
    return message !== undefined ? `Deprecated ${setting}: ${message}` : `Deprecated ${setting}`;
  }
  return readNonEmptyString(record.message) ?? JSON.stringify(warning);
}

function appendUniqueWarnings(target: string[], incoming: readonly string[]): void {
  for (const warning of incoming) {
    if (!target.includes(warning)) target.push(warning);
  }
}

function extractGatewayAsyncJob(
  providerMetadata: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return asRecord(asRecord(asRecord(providerMetadata)?.gateway)?.asyncJob);
}

function extractGatewayExpiresAt(providerMetadata: unknown): string | undefined {
  const raw = asRecord(extractGatewayAsyncJob(providerMetadata)?.result)?.expiresAt;
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    const date = new Date(raw < 1e12 ? raw * 1000 : raw);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = readNonEmptyString(raw);
  return text !== undefined && !Number.isNaN(Date.parse(text)) ? text : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function usableMediaType(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeMediaType(value);
  return normalized.length === 0 || normalized === "application/octet-stream"
    ? undefined
    : normalized;
}

function createTimeoutError(modelId: string, timeoutMs: number, jobId?: string): Error {
  return new Error(
    `Video generation with model "${modelId}"${jobId !== undefined ? ` (job ${jobId})` : ""} timed out after ${timeoutMs}ms.`,
  );
}

function isTransientPollError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }
  const retryable = extractRetryableFlag(error);
  if (retryable !== undefined) return retryable;
  return true;
}

export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  const statusCode = extractStatusCode(error);
  if (statusCode !== undefined) {
    return statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }
  const retryable = extractRetryableFlag(error);
  if (retryable !== undefined) return retryable;
  const code = extractErrorCode(error);
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) return true;
  if (error instanceof TypeError && /\bfetch\b|network/i.test(error.message)) return true;
  return false;
}

function extractRetryableFlag(error: unknown): boolean | undefined {
  const record = asRecord(error);
  if (record === undefined) return undefined;
  if (typeof record.isRetryable === "boolean") return record.isRetryable;
  return record.cause !== undefined && record.cause !== error
    ? extractRetryableFlag(record.cause)
    : undefined;
}

function extractErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  if (record === undefined) return undefined;
  if (typeof record.code === "string" && record.code.length > 0) return record.code;
  return record.cause !== undefined && record.cause !== error
    ? extractErrorCode(record.cause)
    : undefined;
}

function extractStatusCode(error: unknown): number | undefined {
  const record = asRecord(error);
  if (record === undefined) return undefined;
  if (typeof record.statusCode === "number" && Number.isFinite(record.statusCode)) {
    return record.statusCode;
  }
  if (typeof record.status === "number" && Number.isFinite(record.status)) return record.status;
  return record.cause !== undefined && record.cause !== error
    ? extractStatusCode(record.cause)
    : undefined;
}

async function cleanupStoredKeys(
  storage: VideoStorage | undefined,
  keys: readonly string[],
): Promise<void> {
  if (storage?.delete === undefined || keys.length === 0) return;
  const deleteFn = storage.delete;
  const cleanupSignal = new AbortController().signal;
  await Promise.allSettled(keys.map((key) => deleteFn({ key, signal: cleanupSignal })));
}
