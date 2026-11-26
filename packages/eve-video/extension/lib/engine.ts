import { createHash, randomUUID } from "node:crypto";

import { experimental_getVideoStatus, experimental_startVideo } from "ai";
import type { SandboxSession } from "eve/sandbox";
import type { WorkflowStepToolContext } from "eve/tools";

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
  videoPath,
} from "./media.ts";
import { resolveConfiguredModel, resolveJobModel } from "./model.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import { normalizeStorageKey } from "./storage/key.ts";
import type { VideoStorage } from "./storage/types.ts";
import type {
  GenerateVideoToolInput,
  GenerateVideoToolOutput,
  GeneratedVideoItem,
  VideoAssetData,
  VideoEditMode,
  VideoExtensionConfig,
  VideoJobHandle,
  VideoJobStatus,
  VideoModelLike,
} from "./types.ts";

const DEFAULT_MAX_VIDEOS_PER_CALL = 4;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 600_000;
const CLEANUP_TIMEOUT_MS = 15_000;

const NO_DESTINATION_ERROR =
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
type AiVideoModel = AiStartVideoOptions["model"];
type AiOperation = Parameters<typeof experimental_getVideoStatus>[1]["operation"];
type AiProviderOptions = NonNullable<AiStartVideoOptions["providerOptions"]>;
type SandboxIo = Pick<SandboxSession, "readBinaryFile" | "writeBinaryFile">;
type MediaKind = "image" | "video" | "audio";

/** Options passed to {@link startVideoJob}. */
export interface StartVideoJobOptions {
  /** Optional `@eve/video` extension configuration controlling models, defaults, limits, and provider options. */
  readonly config?: VideoExtensionConfig;
  /** Video generation prompt and parameters. */
  readonly input: GenerateVideoToolInput;
  /** Optional storage adapter used to read stored input keys or stage local input files as public HTTPS URLs. */
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
  readonly xaiVideoOptions?: Readonly<Record<string, unknown>>;
  readonly stagedKeys: readonly string[];
}

interface PreparedJobContext {
  readonly config: VideoExtensionConfig;
  readonly signal: AbortSignal;
  readonly params: PreparedParameters;
  readonly modelId: string;
  readonly model: VideoModelLike;
  readonly supportsAsync: boolean;
  readonly storage?: VideoStorage;
  readonly sandbox?: SandboxIo;
  readonly media: ResolvedInputMedia;
  readonly providerOptions?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
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
    return await startPreparedJob(ctx, {
      headers: options.headers,
      idempotencyKey: options.idempotencyKey,
      webhookUrl,
    });
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
  const { baseId, dir } = createKeyPrefix("videos");
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
      if (bytes.byteLength === 0) {
        throw new Error("The video model returned an empty video payload.");
      }
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
          key: `${dir}/${filename}`,
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

export function createIdempotencyKey(sessionId: string, callId: string): string {
  return createHash("sha256").update(`${sessionId}:${callId}`).digest("hex");
}

export async function submitToolVideoJob(
  config: VideoExtensionConfig,
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrlCandidate?: string,
): Promise<SubmitVideoStepResult> {
  const prepared = await prepareJobContext({
    config,
    input,
    getSandbox: () => ctx.getSandbox(),
    signal: ctx.abortSignal,
    requireAsync: false,
    requireDestination: true,
  });
  const idempotencyKey = createIdempotencyKey(ctx.session.id, ctx.callId);
  if (!prepared.supportsAsync) {
    const output = await executeSyncVideoModel(prepared, {
      sessionId: ctx.session.id,
      idempotencyKey,
    });
    return { kind: "completed", output };
  }

  try {
    const intervalMs = config.poll?.intervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeoutMs = config.poll?.timeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    if (!Number.isFinite(intervalMs) || intervalMs < 0) {
      throw new Error(`Invalid poll.intervalMs: ${intervalMs}.`);
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`Invalid poll.timeoutMs: expected a positive number, received ${timeoutMs}.`);
    }

    const webhookUrl =
      config.webhook !== "never" &&
      typeof prepared.model.handleWebhookOption === "function" &&
      webhookUrlCandidate !== undefined
        ? await assertSafePublicUrl(webhookUrlCandidate, { resolveDns: false })
            .then((url) => url.href)
            .catch(() => undefined)
        : undefined;

    const handle = await startPreparedJob(prepared, { idempotencyKey, webhookUrl });
    return {
      kind: "async",
      handle,
      useWebhook: webhookUrl !== undefined && handle.webhookSigningSecret !== undefined,
      intervalMs,
      timeoutMs,
    };
  } catch (error) {
    await cleanupStoredKeys(prepared.storage, prepared.media.stagedKeys);
    throw error;
  }
}

export async function checkAndPersistToolVideoJob(
  config: VideoExtensionConfig,
  input: GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  handle: VideoJobHandle,
): Promise<CheckAndPersistStepResult> {
  ctx.abortSignal.throwIfAborted();
  const status = await checkVideoJob({
    config,
    modelId: handle.modelId,
    operation: handle.operation,
    maxRetries: 0,
    signal: ctx.abortSignal,
  });
  if (status.status === "pending") {
    return { status: "pending", warnings: status.warnings };
  }
  if (status.status === "error") {
    throw new Error(status.error || "Video generation failed.");
  }

  const outputPath = normalizeOptionalPath(input.path);
  const storage = resolveConfiguredStorage(config.storage);
  const sandbox =
    outputPath !== undefined
      ? (
          await resolveSandbox(() => ctx.getSandbox(), {
            forInput: false,
            forOutput: true,
            allowFallback: false,
            signal: ctx.abortSignal,
          })
        ).sandbox
      : undefined;

  const persisted = await persistVideos({
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

  const warnings = [...new Set([...handle.warnings, ...status.warnings])];
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

export async function runSyncVideoModel(options: {
  readonly config?: VideoExtensionConfig;
  readonly input: GenerateVideoToolInput;
  readonly getSandbox?: () => Promise<SandboxIo>;
  readonly sessionId?: string;
  readonly idempotencyKey?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly fetch?: typeof fetch;
}): Promise<GenerateVideoToolOutput> {
  const prepared = await prepareJobContext({
    ...options,
    requireAsync: false,
    requireDestination: true,
  });
  return executeSyncVideoModel(prepared, options);
}

async function startPreparedJob(
  ctx: PreparedJobContext,
  options: {
    readonly headers?: Readonly<Record<string, string>>;
    readonly idempotencyKey?: string;
    readonly webhookUrl?: string;
  },
): Promise<VideoJobHandle> {
  const result = await experimental_startVideo(
    buildStartCallOptions(ctx, {
      headers: buildRequestHeaders(options.headers, options.idempotencyKey),
      webhookUrl: options.webhookUrl,
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
}

async function executeSyncVideoModel(
  ctx: PreparedJobContext,
  options: {
    readonly sessionId?: string;
    readonly idempotencyKey?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly fetch?: typeof fetch;
  },
): Promise<GenerateVideoToolOutput> {
  const { config, signal, params, modelId, storage, sandbox, media } = ctx;
  try {
    const headers = buildRequestHeaders(options.headers, options.idempotencyKey);
    const toFile = (entry: ResolvedMediaEntry) =>
      entry.url !== undefined
        ? {
            type: "url",
            url: entry.url,
            ...(entry.mediaType !== undefined && { mediaType: entry.mediaType }),
          }
        : { type: "file", data: entry.data, mediaType: entry.mediaType ?? "image/png" };

    const frameImages =
      media.frames.length > 0
        ? media.frames.map((f) => ({ image: toFile(f), frameType: f.frameType ?? "first_frame" }))
        : undefined;
    const firstFrame = frameImages?.find((f) => f.frameType === "first_frame")?.image;
    const inputReferences =
      frameImages === undefined && media.references.length > 0
        ? media.references.map(toFile)
        : undefined;

    const perCall = (await resolveModelMaxVideosPerCall(ctx.model)) ?? 1;
    const batchCounts: number[] = [];
    for (let remaining = params.n; remaining > 0; remaining -= perCall) {
      batchCounts.push(Math.min(remaining, perCall));
    }

    const rawResults = await Promise.all(
      batchCounts.map((batchN) =>
        ctx.model.doGenerate!({
          prompt: params.prompt,
          n: batchN,
          aspectRatio: params.aspectRatio,
          resolution: params.resolution,
          duration: params.duration,
          fps: params.fps,
          seed: params.seed,
          image: firstFrame,
          frameImages,
          inputReferences,
          generateAudio: params.generateAudio,
          providerOptions:
            ctx.providerOptions !== undefined ? toAiProviderOptions(ctx.providerOptions) : {},
          ...(headers !== undefined && { headers }),
          abortSignal: signal,
        }),
      ),
    );

    const videos: VideoAssetData[] = [];
    const warningList: string[] = [];
    if (frameImages !== undefined && media.references.length > 0) {
      warningList.push(
        "inputReferences were ignored because frameImages were provided; frameImages and inputReferences cannot be combined.",
      );
    }
    let providerExpiresAt: string | undefined;
    for (const rawResult of rawResults) {
      const record = asRecord(rawResult);
      if (record === undefined || !Array.isArray(record.videos)) {
        throw new Error(`Video model "${modelId}" returned an invalid result.`);
      }
      videos.push(...(record.videos as readonly VideoAssetData[]).map((v) => ({ ...v })));
      if (Array.isArray(record.warnings)) {
        warningList.push(...formatWarnings(record.warnings));
      }
      providerExpiresAt ??= extractGatewayExpiresAt(record.providerMetadata);
    }

    const persisted = await persistVideos({
      videos,
      modelId,
      maxOutputBytes: params.maxOutputBytes,
      signal,
      ...(storage !== undefined && { storage }),
      ...(sandbox !== undefined && { sandbox }),
      ...(params.path !== undefined && { path: params.path }),
      ...(options.sessionId !== undefined && { sessionId: options.sessionId }),
      ...(config.allowTemporaryProviderUrl !== undefined && {
        allowTemporaryProviderUrl: config.allowTemporaryProviderUrl,
      }),
      ...(providerExpiresAt !== undefined && { providerExpiresAt }),
      ...(options.fetch !== undefined && { fetch: options.fetch }),
    });
    const warnings = [...new Set(warningList)];
    return {
      status: "completed",
      model: modelId,
      videos: persisted,
      ...(warnings.length > 0 && { warnings }),
    };
  } finally {
    await cleanupStoredKeys(storage, media.stagedKeys);
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
}): Promise<PreparedJobContext> {
  const config = options.config ?? {};
  const signal = options.signal ?? new AbortController().signal;
  signal.throwIfAborted();

  const { modelId, model } = resolveConfiguredModel(config, options.input.model);
  const supportsAsync = typeof model.doStart === "function" && typeof model.doStatus === "function";
  if (options.requireAsync && !supportsAsync) {
    throw new Error(`Video model "${modelId}" does not support asynchronous start/status jobs.`);
  }

  const grokModel = isGrokVideoModel(modelId, model.provider);
  const seedanceModel = isSeedanceVideoModel(modelId, model.provider);
  const videoEditMode: VideoEditMode | undefined =
    options.input.video !== undefined ? (options.input.mode ?? "edit") : undefined;

  const params = prepareGenerationParameters(config, options.input, {
    omitDuration: grokModel && videoEditMode === "edit",
    omitAspectRatio:
      (grokModel && videoEditMode === "edit") || (seedanceModel && videoEditMode === "extend"),
    omitResolution: grokModel && videoEditMode === "edit",
  });

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
  const forInput = hasLocalMediaInput(options.input);
  const sandboxState =
    forOutput || forInput
      ? await resolveSandbox(options.getSandbox, {
          forInput,
          forOutput,
          allowFallback: !forOutput && storage?.get !== undefined,
          signal,
        })
      : undefined;

  const media = await resolveInputMedia({
    input: options.input,
    modelId,
    grokModel,
    videoEditMode,
    sandbox: sandboxState?.sandbox,
    sandboxError: sandboxState?.error,
    storage,
    maxInputBytes: params.maxInputBytes,
    stageLargeInputs: supportsAsync,
    signal,
  });

  const providerOptions =
    media.xaiVideoOptions !== undefined
      ? {
          ...config.providerOptions,
          xai: { ...config.providerOptions?.xai, ...media.xaiVideoOptions },
        }
      : config.providerOptions;

  return {
    config,
    signal,
    params,
    modelId,
    model,
    supportsAsync,
    storage,
    sandbox: sandboxState?.sandbox,
    media,
    providerOptions,
  };
}

function hasLocalMediaInput(input: GenerateVideoToolInput): boolean {
  return [input.video, input.start, input.end, ...(input.references ?? [])].some(
    (entry) => entry !== undefined && !isUrlLike(entry),
  );
}

function isGrokVideoModel(modelId: string, provider: string): boolean {
  return (
    /^(?:spacexai|xai)\/grok-imagine-video/i.test(modelId) ||
    /^(?:spacexai|xai)(?:\.|$)/i.test(provider)
  );
}

function isSeedanceVideoModel(modelId: string, provider: string): boolean {
  return /^bytedance\/seedance/i.test(modelId) || /^bytedance(?:\.|$)/i.test(provider);
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
  omit: {
    readonly omitDuration: boolean;
    readonly omitAspectRatio: boolean;
    readonly omitResolution: boolean;
  },
): PreparedParameters {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) throw new Error("Video prompt must be a non-empty string.");

  if (input.mode !== undefined && input.video === undefined) {
    throw new Error('"mode" ("edit" or "extend") requires "video" to be provided.');
  }
  if (input.mode !== undefined && input.mode !== "edit" && input.mode !== "extend") {
    throw new Error(`Invalid "mode" "${String(input.mode)}". Expected "edit" or "extend".`);
  }
  if (input.video !== undefined && input.video.trim().length === 0) {
    throw new Error('Input "video" must be a non-empty URL, storage key, or sandbox file path.');
  }
  if (input.video !== undefined && (input.start !== undefined || input.end !== undefined)) {
    throw new Error('"video" cannot be combined with "start" or "end" frame images.');
  }

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
  if (maxDurationSeconds !== undefined) {
    assertPositive(maxDurationSeconds, "limits.maxDurationSeconds");
  }
  const duration = omit.omitDuration ? undefined : (input.duration ?? config.defaults?.duration);
  if (duration !== undefined) {
    assertPositive(duration, "video duration");
    if (maxDurationSeconds !== undefined && duration > maxDurationSeconds) {
      throw new Error(
        `Requested video duration ${duration}s exceeds the configured maximum of ${maxDurationSeconds}s.`,
      );
    }
  } else if (input.duration !== undefined) {
    assertPositive(input.duration, "video duration");
  }

  const rawAspectRatio = omit.omitAspectRatio
    ? undefined
    : (input.aspectRatio ?? config.defaults?.aspectRatio);
  const aspectRatio =
    rawAspectRatio !== undefined ? normalizeAspectRatio(rawAspectRatio) : undefined;
  const rawResolution = omit.omitResolution
    ? undefined
    : (input.resolution ?? config.defaults?.resolution);
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
  readonly modelId: string;
  readonly grokModel: boolean;
  readonly videoEditMode?: VideoEditMode;
  readonly sandbox?: SandboxIo;
  readonly sandboxError?: Error;
  readonly storage?: VideoStorage;
  readonly maxInputBytes: number;
  readonly stageLargeInputs: boolean;
  readonly signal: AbortSignal;
}): Promise<ResolvedInputMedia> {
  const resolveEntry = (
    raw: string,
    slot: string,
    allowedKinds: readonly MediaKind[],
    extra?: {
      readonly frameType?: "first_frame" | "last_frame";
      readonly defaultUrlMediaType?: string;
    },
  ) => resolveMediaEntry(options, raw, slot, allowedKinds, extra);

  const videoEntry =
    options.input.video !== undefined
      ? await resolveEntry(options.input.video, "video", ["video"], {
          defaultUrlMediaType: "video/mp4",
        })
      : undefined;

  const frames: ResolvedMediaEntry[] = [];
  if (options.input.start !== undefined) {
    frames.push(
      await resolveEntry(options.input.start, "start", ["image"], { frameType: "first_frame" }),
    );
  }
  if (options.input.end !== undefined) {
    frames.push(
      await resolveEntry(options.input.end, "end", ["image"], { frameType: "last_frame" }),
    );
  }

  const references: ResolvedMediaEntry[] = [];
  if (videoEntry !== undefined && !options.grokModel) references.push(videoEntry);
  for (let i = 0; i < (options.input.references?.length ?? 0); i += 1) {
    references.push(
      await resolveEntry(options.input.references![i], `ref-${i}`, ["image", "video", "audio"]),
    );
  }

  const stagedKeys: string[] = [];
  let prefix: string | undefined;
  let grokVideoUrl: string | undefined;
  const getPrefix = () => {
    if (prefix === undefined) {
      const { dir, baseId } = createKeyPrefix("inputs");
      prefix = `${dir}/${baseId}`;
    }
    return prefix;
  };

  try {
    if (videoEntry !== undefined && options.grokModel) {
      if (videoEntry.url !== undefined) {
        grokVideoUrl = videoEntry.url;
      } else {
        const staged =
          options.storage !== undefined
            ? await stageMediaEntry(options.storage, getPrefix(), videoEntry, options.signal)
            : null;
        if (staged === null) {
          throw new Error(
            `Video editing/extension with "${options.modelId}" requires a public https:// video URL. Configure public HTTPS video storage (such as vercelBlob()) or pass an https:// video URL.`,
          );
        }
        stagedKeys.push(staged.key);
        grokVideoUrl = staged.url;
      }
    }

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
      for (const entry of localEntries) {
        if (remainingInlineBytes <= ASYNC_INLINE_INPUT_LIMIT_BYTES) break;
        const staged = await stageMediaEntry(options.storage, getPrefix(), entry, options.signal);
        if (staged === null) break;
        stagedKeys.push(staged.key);
        remainingInlineBytes -= entry.data?.byteLength ?? 0;
        entry.url = staged.url;
        entry.data = undefined;
      }
    }
  } catch (error) {
    await cleanupStoredKeys(options.storage, stagedKeys);
    throw error;
  }

  return {
    frames,
    references,
    stagedKeys,
    ...(grokVideoUrl !== undefined && {
      xaiVideoOptions: {
        videoUrl: grokVideoUrl,
        ...(options.videoEditMode === "extend" && { mode: "extend-video" }),
      },
    }),
  };
}

async function stageMediaEntry(
  storage: VideoStorage,
  prefix: string,
  entry: ResolvedMediaEntry,
  signal: AbortSignal,
): Promise<{ readonly key: string; readonly url: string } | null> {
  if (entry.data === undefined || entry.mediaType === undefined) return null;
  const filename = `${entry.slot}${extensionForMediaType(entry.mediaType)}`;
  const stored = await storage.put({
    key: `${prefix}/${filename}`,
    data: entry.data,
    mediaType: entry.mediaType,
    filename,
    ttlDays: 1,
    signal,
  });
  const safeUrl =
    stored.url !== undefined && stored.visibility !== "private"
      ? await assertSafePublicUrl(stored.url, { resolveDns: false }).catch(() => undefined)
      : undefined;
  if (safeUrl === undefined) {
    await cleanupStoredKeys(storage, [stored.key]);
    return null;
  }
  return { key: stored.key, url: safeUrl.href };
}

async function resolveMediaEntry(
  env: {
    readonly sandbox?: SandboxIo;
    readonly sandboxError?: Error;
    readonly storage?: VideoStorage;
    readonly maxInputBytes: number;
    readonly signal: AbortSignal;
  },
  raw: string,
  slot: string,
  allowedKinds: readonly MediaKind[],
  extra?: {
    readonly frameType?: "first_frame" | "last_frame";
    readonly defaultUrlMediaType?: string;
  },
): Promise<ResolvedMediaEntry> {
  const trimmed = raw.trim();
  if (isUrlLike(trimmed)) {
    const safeUrl = await assertSafePublicUrl(trimmed, { resolveDns: false });
    const inferred = mediaTypeFromUrl(safeUrl.href);
    if (inferred !== undefined) {
      const kind = mediaKind(inferred);
      if (kind === "other" || !allowedKinds.includes(kind)) {
        throw new Error(
          `Unsupported media type "${inferred}" for "${slot}" URL "${trimmed}". Expected ${allowedKinds.join(" or ")}.`,
        );
      }
    }
    const mediaType = inferred ?? extra?.defaultUrlMediaType;
    return {
      slot,
      url: safeUrl.href,
      ...(extra?.frameType !== undefined && { frameType: extra.frameType }),
      ...(mediaType !== undefined && { mediaType }),
    };
  }

  let data: Uint8Array | null = null;
  let declaredMediaType: string | undefined;
  if (env.sandbox !== undefined) {
    data = await env.sandbox.readBinaryFile({ path: trimmed, signal: env.signal });
  }
  if (data === null && env.storage?.get !== undefined) {
    const key = tryNormalizeStorageKey(trimmed);
    if (key !== undefined) {
      const stored = await env.storage.get({ key, signal: env.signal });
      if (stored !== null) {
        data = stored.data;
        declaredMediaType = stored.mediaType;
      }
    }
  }
  if (data === null) {
    if (env.sandbox !== undefined) {
      throw new Error(
        env.storage?.get !== undefined
          ? `File not found in sandbox or video storage: ${trimmed}`
          : `File not found in sandbox: ${trimmed}`,
      );
    }
    if (slot === "video" && env.storage?.get !== undefined) {
      throw new Error(
        `Video "${trimmed}" was not found in video storage, and reading local input files requires an agent sandbox. Pass an https:// URL, a valid storageKey, or configure a sandbox.`,
      );
    }
    throw (
      env.sandboxError ?? new Error(missingSandboxMessage({ forInput: true, forOutput: false }))
    );
  }
  if (data.byteLength === 0) throw new Error(`Media file is empty: ${trimmed}`);
  if (data.byteLength > env.maxInputBytes) {
    throw new Error(
      `Media file "${trimmed}" (${data.byteLength} bytes) exceeds maximum allowed size of ${env.maxInputBytes} bytes.`,
    );
  }
  const mediaType = detectMediaType(data) ?? usableMediaType(declaredMediaType);
  if (mediaType === undefined) {
    throw new Error(`Unsupported or unrecognized media file format: ${trimmed}`);
  }
  const kind = mediaKind(mediaType);
  if (kind === "other" || !allowedKinds.includes(kind)) {
    throw new Error(
      `Unsupported media type "${mediaType}" for "${trimmed}". Expected ${allowedKinds.join(" or ")}.`,
    );
  }
  return {
    slot,
    data,
    mediaType,
    ...(extra?.frameType !== undefined && { frameType: extra.frameType }),
  };
}

function tryNormalizeStorageKey(raw: string): string | undefined {
  try {
    return normalizeStorageKey(raw);
  } catch {
    return undefined;
  }
}

function buildStartCallOptions(
  ctx: PreparedJobContext,
  extra: { readonly headers?: Record<string, string>; readonly webhookUrl?: string },
): AiStartVideoOptions {
  const { frames, references } = ctx.media;
  return {
    model: toAiVideoModel(ctx.model),
    prompt: ctx.params.prompt,
    n: ctx.params.n,
    abortSignal: ctx.signal,
    ...(ctx.params.duration !== undefined && { duration: ctx.params.duration }),
    ...(ctx.params.aspectRatio !== undefined && { aspectRatio: ctx.params.aspectRatio }),
    ...(ctx.params.resolution !== undefined && { resolution: ctx.params.resolution }),
    ...(ctx.params.generateAudio !== undefined && { generateAudio: ctx.params.generateAudio }),
    ...(ctx.params.fps !== undefined && { fps: ctx.params.fps }),
    ...(ctx.params.seed !== undefined && { seed: ctx.params.seed }),
    ...(frames.length > 0 && {
      frameImages: frames.map((f) => ({
        image: f.url ?? f.data!,
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
              data: r.data!,
              ...(r.mediaType !== undefined && { mediaType: r.mediaType }),
            },
      ),
    }),
    ...(ctx.providerOptions !== undefined && {
      providerOptions: toAiProviderOptions(ctx.providerOptions),
    }),
    ...(extra.headers !== undefined && { headers: extra.headers }),
    ...(extra.webhookUrl !== undefined && { webhookUrl: extra.webhookUrl }),
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
  return Object.fromEntries(
    Object.entries(providerOptions).map(([provider, values]) => [provider, { ...values }]),
  ) as AiProviderOptions;
}

function createKeyPrefix(folder: "videos" | "inputs"): {
  readonly baseId: string;
  readonly dir: string;
} {
  return {
    baseId: `vid_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
    dir: `${folder}/${new Date().toISOString().slice(0, 10)}`,
  };
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

function normalizeOptionalPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const trimmed = path.trim();
  if (trimmed.length === 0) throw new Error('Sandbox output "path" must be a non-empty string.');
  return trimmed;
}

async function resolveSandbox(
  getSandbox: (() => Promise<SandboxIo>) | undefined,
  options: {
    readonly forInput: boolean;
    readonly forOutput: boolean;
    readonly allowFallback: boolean;
    readonly signal: AbortSignal;
  },
): Promise<{ readonly sandbox?: SandboxIo; readonly error?: Error }> {
  if (getSandbox === undefined) {
    if (options.allowFallback) return {};
    throw new Error(missingSandboxMessage(options));
  }
  try {
    return { sandbox: await getSandbox() };
  } catch (error) {
    if (options.signal.aborted) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    const wrapped = new Error(`${missingSandboxMessage(options)} (${detail})`, { cause: error });
    if (options.allowFallback) return { error: wrapped };
    throw wrapped;
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
  return warnings === undefined ? [] : [...new Set(warnings.map(formatWarning).filter(Boolean))];
}

function formatWarning(warning: unknown): string {
  if (typeof warning === "string") return warning.trim();
  const r = asRecord(warning);
  if (r === undefined) return String(warning);
  const details = readNonEmptyString(r.details);
  const feature = typeof r.feature === "string" ? r.feature : "feature";
  if (r.type === "unsupported") {
    return details !== undefined ? `Unsupported ${feature}: ${details}` : `Unsupported ${feature}`;
  }
  if (r.type === "compatibility") {
    return details !== undefined
      ? `Compatibility (${feature}): ${details}`
      : `Compatibility warning for ${feature}`;
  }
  if (r.type === "deprecated") {
    const setting = typeof r.setting === "string" ? r.setting : "setting";
    const message = readNonEmptyString(r.message);
    return message !== undefined ? `Deprecated ${setting}: ${message}` : `Deprecated ${setting}`;
  }
  return readNonEmptyString(r.message) ?? JSON.stringify(warning);
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

export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  if (error instanceof Error && error.name === "TimeoutError") return true;
  let retryable: boolean | undefined;
  let code: string | undefined;
  const seen = new Set<unknown>();
  for (let current: unknown = error; current !== undefined && !seen.has(current);) {
    seen.add(current);
    const record = asRecord(current);
    if (record === undefined) break;
    const status =
      typeof record.statusCode === "number" && Number.isFinite(record.statusCode)
        ? record.statusCode
        : typeof record.status === "number" && Number.isFinite(record.status)
          ? record.status
          : undefined;
    if (status !== undefined) {
      return status === 408 || status === 429 || status >= 500;
    }
    if (retryable === undefined && typeof record.isRetryable === "boolean") {
      retryable = record.isRetryable;
    }
    if (code === undefined && typeof record.code === "string" && record.code.length > 0) {
      code = record.code;
    }
    current = record.cause;
  }
  if (retryable !== undefined) return retryable;
  if (code !== undefined && TRANSIENT_ERROR_CODES.has(code)) return true;
  return error instanceof TypeError && /\bfetch\b|network/i.test(error.message);
}

export async function cleanupStoredKeys(
  storage: VideoStorage | undefined,
  keys: readonly string[],
): Promise<void> {
  if (storage?.delete === undefined || keys.length === 0) return;
  const deleteFn = storage.delete;
  await Promise.allSettled(
    keys.map((key) => deleteFn({ key, signal: AbortSignal.timeout(CLEANUP_TIMEOUT_MS) })),
  );
}
