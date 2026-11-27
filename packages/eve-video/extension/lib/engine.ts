import { createHash, randomUUID } from "node:crypto";

import {
  experimental_generateVideo as generateVideo,
  experimental_getVideoStatus as getVideoStatus,
  experimental_startVideo as startVideo,
} from "ai";
import type { SandboxSession } from "eve/sandbox";
import type { WorkflowStepToolContext } from "eve/tools";

import * as media from "./media.ts";
import { resolveConfiguredModel, resolveJobModel } from "./model.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import { normalizeStorageKey } from "./storage/key.ts";
import type { VideoStorage } from "./storage/types.ts";
import type * as t from "./types.ts";

const NO_DEST =
  'No video output destination is configured. Configure video storage or pass "path".';
const WARN_PREFIX: Record<string, string> = {
  unsupported: "Unsupported",
  compatibility: "Compatibility",
  deprecated: "Deprecated",
};
const TRANSIENT_CODES = new Set(
  "ECONNRESET ECONNREFUSED ECONNABORTED ETIMEDOUT EPIPE EAI_AGAIN ENOTFOUND EHOSTUNREACH ENETUNREACH UND_ERR_CONNECT_TIMEOUT UND_ERR_HEADERS_TIMEOUT UND_ERR_BODY_TIMEOUT UND_ERR_SOCKET UND_ERR_CLOSED UND_ERR_ABORTED ERR_SOCKET_CLOSED ERR_STREAM_PREMATURE_CLOSE".split(
    " ",
  ),
);

type AiStartOpts = Parameters<typeof startVideo>[0];
type VideoAsset = Extract<
  Awaited<ReturnType<typeof getVideoStatus>>,
  { status: "completed" }
>["videos"][number];
interface ResolvedMedia {
  readonly slot: string;
  readonly frameType?: "first_frame" | "last_frame";
  url?: string;
  data?: Uint8Array;
  mediaType?: string;
}

export type SubmitVideoStepResult =
  | { readonly kind: "completed"; readonly output: t.GenerateVideoToolOutput }
  | {
      readonly kind: "async";
      readonly handle: t.VideoJobHandle;
      readonly useWebhook: boolean;
      readonly intervalMs: number;
      readonly timeoutMs: number;
    };

export type CheckAndPersistStepResult =
  | { readonly status: "pending"; readonly warnings: readonly string[] }
  | { readonly status: "completed"; readonly output: t.GenerateVideoToolOutput };

export const createIdempotencyKey = (sessionId: string, callId: string): string =>
  createHash("sha256").update(`${sessionId}:${callId}`).digest("hex");

export async function submitToolVideoJob(
  config: t.VideoExtensionConfig,
  input: t.GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  webhookUrlCandidate?: string,
): Promise<SubmitVideoStepResult> {
  const signal = ctx.abortSignal;
  signal.throwIfAborted();

  const { modelId, model } = resolveConfiguredModel(config);
  const isAsync = typeof model.doStart === "function" && typeof model.doStatus === "function";
  const grok =
    /^(?:spacexai|xai)\/grok-imagine-video/i.test(modelId) ||
    /^(?:spacexai|xai)(?:\.|$)/i.test(model.provider);
  const seedance =
    /^bytedance\/seedance/i.test(modelId) || /^bytedance(?:\.|$)/i.test(model.provider);
  const isEdit = input.video !== undefined && !input.extend;
  const isExtend = input.video !== undefined && Boolean(input.extend);
  const { limits: lim, defaults: def } = config;

  const prompt = input.prompt.trim();
  if (!prompt) throw new Error("Video prompt must be a non-empty string.");
  if (input.extend && input.video === undefined)
    throw new Error('"extend" requires "video" to be provided.');
  if (input.video !== undefined && (input.start !== undefined || input.end !== undefined))
    throw new Error('"video" cannot be combined with "start" or "end" frame images.');
  for (const k of ["video", "start", "end", "path"] as const)
    if (input[k] !== undefined && !input[k].trim())
      throw new Error(`Input "${k}" must be a non-empty string.`);
  if (input.references && input.references.length > media.MAX_REFERENCE_COUNT)
    throw new Error(`At most ${media.MAX_REFERENCE_COUNT} reference items are allowed.`);
  if (input.references?.some((r) => !r.trim()))
    throw new Error('Entries in "references" must be non-empty.');

  const n = pos(input.n ?? 1, 'video count "n"', true);
  const maxV = pos(lim?.maxVideosPerCall ?? 4, "limits.maxVideosPerCall", true);
  if (n > maxV)
    throw new Error(
      `Requested ${n} videos; exceeds the configured maximum of ${maxV} videos per call.`,
    );
  if (isAsync) {
    const m =
      typeof model.maxVideosPerCall === "function"
        ? await model.maxVideosPerCall({ modelId: model.modelId })
        : model.maxVideosPerCall;
    if (typeof m === "number" && Number.isInteger(m) && m > 0 && n > m)
      throw new Error(`Model "${modelId}" allows at most ${m} video(s) per async call.`);
  }

  const maxDur =
    lim?.maxDurationSeconds !== undefined
      ? pos(lim.maxDurationSeconds, "maxDurationSeconds")
      : undefined;
  const duration = isEdit ? undefined : (input.duration ?? def?.duration);
  if ((duration ?? input.duration) !== undefined)
    pos((duration ?? input.duration)!, "video duration");
  if (duration !== undefined && maxDur !== undefined && duration > maxDur)
    throw new Error(`Duration ${duration}s exceeds the configured maximum of ${maxDur}s.`);

  const ratioIn =
    isEdit || (seedance && isExtend) ? undefined : (input.aspectRatio ?? def?.aspectRatio);
  const aspectRatio = ratioIn !== undefined ? media.normalizeAspectRatio(ratioIn) : undefined;
  const resIn = grok && isEdit ? undefined : (input.resolution ?? def?.resolution);
  const resolution =
    resIn !== undefined ? media.normalizeResolution(resIn, aspectRatio) : undefined;
  const fps = input.fps ?? def?.fps;
  if (fps !== undefined) pos(fps, "video fps");
  if (input.seed !== undefined && !Number.isInteger(input.seed))
    throw new Error(`Invalid seed: ${input.seed}.`);

  const outputPath = input.path?.trim();
  const maxIn = pos(lim?.maxInputBytes ?? media.DEFAULT_MAX_INPUT_BYTES, "maxInputBytes");
  const maxOut = pos(lim?.maxOutputBytes ?? media.DEFAULT_MAX_OUTPUT_BYTES, "maxOutputBytes");
  const intervalMs = config.poll?.intervalMs ?? 5_000;
  const timeoutMs = config.poll?.timeoutMs ?? 600_000;
  if (isAsync && (!Number.isFinite(intervalMs) || intervalMs < 0))
    throw new Error(`Invalid poll.intervalMs: ${intervalMs}.`);
  if (isAsync) pos(timeoutMs, "poll.timeoutMs");

  const storage = resolveConfiguredStorage(config.storage);
  if (!storage && !outputPath) throw new Error(NO_DEST);

  const hasLocal = [input.video, input.start, input.end, ...(input.references ?? [])].some(
    (e) => e !== undefined && !media.isUrlLike(e),
  );
  const sb =
    outputPath || hasLocal
      ? await resolveSandbox(
          ctx,
          outputPath ? 'Writing to "path"' : "Reading local inputs",
          !outputPath && Boolean(storage?.get),
        )
      : undefined;

  const stagedKeys: string[] = [];
  let stagePrefix: string | undefined;
  const signKey = async (key: string): Promise<string | null> => {
    if (!storage?.getSignedUrl) return null;
    const raw = await storage
      .getSignedUrl({ key, expiresInSeconds: 900, signal })
      .catch(() => null);
    if (!raw) return null;
    const safe = await media.assertSafePublicUrl(raw, { resolveDns: false }).catch(() => undefined);
    return safe?.href ?? null;
  };
  const stage = async (entry: ResolvedMedia): Promise<string | null> => {
    if (!storage || !entry.data || !entry.mediaType) return null;
    const filename = `${entry.slot}${media.extensionForMediaType(entry.mediaType)}`;
    const stored = await storage.put({
      key: `${(stagePrefix ??= `inputs/${day()}/${uid()}`)}/${filename}`,
      data: entry.data,
      mediaType: entry.mediaType,
      filename,
      ttlDays: 1,
      signal,
    });
    const rawUrl =
      stored.url && stored.visibility !== "private" ? stored.url : await signKey(stored.key);
    const safe = rawUrl
      ? await media.assertSafePublicUrl(rawUrl, { resolveDns: false }).catch(() => undefined)
      : undefined;
    if (!safe) {
      await cleanupStoredKeys(storage, [stored.key]);
      return null;
    }
    stagedKeys.push(stored.key);
    return safe.href;
  };

  const isGateway = model.provider === "gateway" || typeof model.handleWebhookOption === "function";
  let totalInputBytes = 0;
  let inlineBytes = 0;
  let canStageInline = isAsync && isGateway && Boolean(storage);

  const load = async (
    raw: string,
    slot: string,
    allowed: readonly ("image" | "video" | "audio")[],
    frameType?: "first_frame" | "last_frame",
    defaultUrlType?: string,
  ): Promise<ResolvedMedia> => {
    const trimmed = raw.trim();
    const checkKind = (mt: string, target: string) => {
      if (media.normalizeMediaType(mt) === "image/svg+xml")
        throw new Error(
          `SVG images are not supported by video models for ${target}; convert SVG to PNG, JPEG, WebP, or GIF first.`,
        );
      const k = media.mediaKind(mt);
      if (k === "other" || !allowed.includes(k))
        throw new Error(`Unsupported media type "${mt}" for ${target}.`);
    };
    if (media.isUrlLike(trimmed)) {
      const safe = await media.assertSafePublicUrl(trimmed, { resolveDns: false });
      const inf = media.mediaTypeFromUrl(safe.href);
      if (inf) checkKind(inf, `"${slot}" URL "${trimmed}"`);
      const mediaType = inf ?? defaultUrlType;
      return {
        slot,
        url: safe.href,
        ...(frameType && { frameType }),
        ...(mediaType && { mediaType }),
      };
    }
    const remaining = maxIn - totalInputBytes;
    if (remaining <= 0)
      throw new Error(`Total input media size exceeds maximum allowed size of ${maxIn} bytes.`);
    let data: Uint8Array | null = null;
    if (sb?.sandbox) {
      const stream = await sb.sandbox.readFile({ path: trimmed, signal });
      if (stream) {
        try {
          data = await media.readBoundedStream(stream, remaining, { signal });
        } catch (err) {
          if (err instanceof media.StreamLimitExceededError)
            throw new Error(
              `Media "${trimmed}" exceeds maximum allowed input size of ${maxIn} bytes.`,
            );
          throw err;
        }
      }
    }
    let declared: string | undefined;
    let fromStorageKey: string | undefined;
    if (data === null && storage?.get) {
      const key = tryKey(trimmed);
      const stored = key ? await storage.get({ key, signal }) : null;
      if (stored) {
        ({ data, mediaType: declared } = stored);
        fromStorageKey = stored.key;
      }
    }
    if (data === null) {
      if (sb?.sandbox)
        throw new Error(
          `File not found in sandbox${storage?.get ? " or storage" : ""}: ${trimmed}`,
        );
      if (slot === "video" && storage?.get)
        throw new Error(`Video "${trimmed}" not found in storage and no sandbox is configured.`);
      throw sb?.error ?? new Error("Reading local input files requires an agent sandbox.");
    }
    if (!data.byteLength) throw new Error(`Media file is empty: ${trimmed}`);
    if (data.byteLength > remaining)
      throw new Error(
        `Media "${trimmed}" (${totalInputBytes + data.byteLength} total bytes) exceeds maximum allowed size of ${maxIn} bytes.`,
      );
    const mediaType = media.detectMediaType(data) ?? usableType(declared);
    if (!mediaType) {
      if (media.mediaTypeForPath(trimmed) === "image/svg+xml")
        checkKind("image/svg+xml", `"${trimmed}"`);
      throw new Error(`Unsupported or unrecognized media file format: ${trimmed}`);
    }
    checkKind(mediaType, `"${trimmed}"`);
    totalInputBytes += data.byteLength;
    const entry: ResolvedMedia = { slot, data, mediaType, ...(frameType && { frameType }) };
    if (slot === "video" && grok) {
      const url = (fromStorageKey ? await signKey(fromStorageKey) : null) ?? (await stage(entry));
      if (!url)
        throw new Error(
          `Model "${modelId}" requires public HTTPS storage, signed storage URLs, or an https:// URL.`,
        );
      entry.url = url;
      entry.data = undefined;
      return entry;
    }
    const weight = data.byteLength * (frameType === "first_frame" ? 2 : 1);
    if (canStageInline && inlineBytes + weight > media.ASYNC_INLINE_INPUT_LIMIT_BYTES) {
      const url = (fromStorageKey ? await signKey(fromStorageKey) : null) ?? (await stage(entry));
      if (url) {
        entry.url = url;
        entry.data = undefined;
        return entry;
      }
      canStageInline = false;
    }
    inlineBytes += weight;
    return entry;
  };

  try {
    const videoEntry = input.video
      ? await load(input.video, "video", ["video"], undefined, "video/mp4")
      : undefined;
    const frames: ResolvedMedia[] = [];
    if (input.start) frames.push(await load(input.start, "start", ["image"], "first_frame"));
    if (input.end) frames.push(await load(input.end, "end", ["image"], "last_frame"));
    const references: ResolvedMedia[] = videoEntry && !grok ? [videoEntry] : [];
    for (let i = 0; i < (input.references?.length ?? 0); i += 1)
      references.push(await load(input.references![i], `ref-${i}`, ["image", "video", "audio"]));

    const grokUrl = videoEntry && grok ? videoEntry.url : undefined;

    const xai = grokUrl
      ? {
          ...config.providerOptions?.xai,
          videoUrl: grokUrl,
          ...(isExtend && { mode: "extend-video" }),
        }
      : undefined;
    const callOptions: AiStartOpts = {
      model: toAiModel(model),
      prompt,
      n,
      duration,
      aspectRatio,
      resolution,
      generateAudio: input.audio ?? def?.audio,
      fps,
      seed: input.seed,
      maxRetries: 0,
      abortSignal: signal,
      headers: { "idempotency-key": createIdempotencyKey(ctx.session.id, ctx.callId) },
      frameImages: frames.length
        ? frames.map((f) => ({ image: f.url ?? f.data!, frameType: f.frameType ?? "first_frame" }))
        : undefined,
      inputReferences: references.length
        ? references.map((r) => ({
            data: r.url ?? r.data!,
            ...(r.mediaType && { mediaType: r.mediaType }),
          }))
        : undefined,
      providerOptions:
        config.providerOptions || xai
          ? ({ ...config.providerOptions, ...(xai && { xai }) } as AiStartOpts["providerOptions"])
          : undefined,
    };

    if (!isAsync) {
      const res = await generateVideo({
        ...callOptions,
        download: ({ url, abortSignal }) =>
          media.downloadVideoBytes(url.href, { maxBytes: maxOut, signal: abortSignal ?? signal }),
      });
      const assets: VideoAsset[] = res.videos.map((v) => ({
        type: "binary",
        data: v.uint8Array,
        mediaType: v.mediaType,
      }));
      for (let i = 0; i < res.uploadedVideos; i += 1)
        assets.push({ type: "uploaded", mediaType: "video/mp4" });
      const output = await finalizeVideos(assets, ctx, {
        modelId,
        storage,
        sandbox: sb?.sandbox,
        path: outputPath,
        maxOut,
        warnings: formatWarnings(res.warnings),
      });
      await cleanupStoredKeys(storage, stagedKeys);
      return { kind: "completed", output };
    }

    const canHook =
      config.webhook !== "never" &&
      typeof model.handleWebhookOption === "function" &&
      webhookUrlCandidate;
    const webhookUrl = canHook ? await resolvePublicWebhookUrl(webhookUrlCandidate) : undefined;
    const res = await startVideo({ ...callOptions, ...(webhookUrl && { webhookUrl }) });
    const job = asRecord(asRecord(asRecord(res.providerMetadata)?.gateway)?.asyncJob);
    const [jobId, webhookSigningSecret] = [readStr(job?.jobId), readStr(job?.webhookSigningSecret)];
    return {
      kind: "async",
      handle: {
        modelId,
        operation: res.operation,
        ...(jobId && { jobId }),
        ...(webhookSigningSecret && { webhookSigningSecret }),
        ...(stagedKeys.length > 0 && { stagedInputKeys: stagedKeys }),
        warnings: formatWarnings(res.warnings),
      },
      useWebhook: Boolean(webhookUrl && webhookSigningSecret),
      intervalMs,
      timeoutMs,
    };
  } catch (error) {
    await cleanupStoredKeys(storage, stagedKeys);
    throw error;
  }
}

export async function checkAndPersistToolVideoJob(
  config: t.VideoExtensionConfig,
  input: t.GenerateVideoToolInput,
  ctx: WorkflowStepToolContext,
  handle: t.VideoJobHandle,
): Promise<CheckAndPersistStepResult> {
  ctx.abortSignal.throwIfAborted();
  const { modelId, model } = resolveJobModel(config, handle.modelId);
  if (typeof model.doStatus !== "function")
    throw new Error(`Model "${modelId}" does not support status checks.`);
  const res = await getVideoStatus(toAiModel(model), {
    operation: handle.operation as Parameters<typeof getVideoStatus>[1]["operation"],
    abortSignal: ctx.abortSignal,
    maxRetries: 0,
  });
  if (res.status === "pending")
    return { status: "pending", warnings: formatWarnings(res.warnings) };
  if (res.status === "error") throw new Error(res.error || "Video generation failed.");

  const outputPath = input.path?.trim();
  if (input.path !== undefined && !outputPath)
    throw new Error('Input "path" must be a non-empty string.');
  const storage = resolveConfiguredStorage(config.storage);
  const sandbox = outputPath
    ? (await resolveSandbox(ctx, 'Writing to "path"', false)).sandbox
    : undefined;
  return {
    status: "completed",
    output: await finalizeVideos(res.videos, ctx, {
      modelId: handle.modelId,
      storage,
      sandbox,
      path: outputPath,
      jobId: handle.jobId,
      maxOut: config.limits?.maxOutputBytes ?? media.DEFAULT_MAX_OUTPUT_BYTES,
      warnings: [...new Set([...handle.warnings, ...formatWarnings(res.warnings)])],
    }),
  };
}

export function isTransientProviderError(error: unknown): boolean {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))
    return error.name === "TimeoutError";
  let retryable: boolean | undefined;
  let code: string | undefined;
  const seen = new Set<unknown>();
  for (
    let cur: unknown = error;
    cur !== undefined && !seen.has(cur);
    cur = asRecord(cur)?.cause ?? asRecord(cur)?.lastError
  ) {
    seen.add(cur);
    const r = asRecord(cur);
    if (!r) break;
    const st =
      typeof r.statusCode === "number"
        ? r.statusCode
        : typeof r.status === "number"
          ? r.status
          : NaN;
    if (Number.isFinite(st)) return st === 408 || st === 429 || st >= 500;
    if (retryable === undefined && typeof r.isRetryable === "boolean") retryable = r.isRetryable;
    if (!code && typeof r.code === "string") code = r.code;
  }
  return (
    retryable ??
    (Boolean(code && TRANSIENT_CODES.has(code)) ||
      (error instanceof TypeError && /\bfetch\b|network/i.test(error.message)))
  );
}

export async function cleanupStoredKeys(
  storage: VideoStorage | undefined,
  keys: readonly string[],
): Promise<void> {
  const del = storage?.delete;
  if (del && keys.length)
    await Promise.allSettled(keys.map((key) => del({ key, signal: AbortSignal.timeout(15_000) })));
}

async function finalizeVideos(
  assets: readonly VideoAsset[],
  ctx: WorkflowStepToolContext,
  o: {
    modelId: string;
    storage?: VideoStorage;
    sandbox?: Pick<SandboxSession, "writeBinaryFile">;
    path?: string;
    jobId?: string;
    maxOut: number;
    warnings: readonly string[];
  },
): Promise<t.GenerateVideoToolOutput> {
  const signal = ctx.abortSignal;
  const { storage, sandbox, path: sandboxPath, maxOut } = o;
  signal.throwIfAborted();
  if (!assets.length) throw new Error("The video model returned no videos.");
  if (sandboxPath && !sandbox) throw new Error('Cannot write video to "path" without a sandbox.');
  if (!storage && !sandboxPath) throw new Error(NO_DEST);

  const [baseId, dir] = [uid(), `videos/${day()}`];
  const storedKeys: string[] = [];
  const videos: t.GeneratedVideoItem[] = [];

  try {
    for (let i = 0; i < assets.length; i += 1) {
      signal.throwIfAborted();
      const video = assets[i];
      if (video.type === "uploaded") {
        videos.push({ mediaType: usableType(video.mediaType) ?? "video/mp4", bytes: 0 });
        continue;
      }
      let bytes: Uint8Array;
      let dlType: string | undefined;
      if (video.type === "url")
        ({ data: bytes, mediaType: dlType } = await media.downloadVideoBytes(video.url, {
          maxBytes: maxOut,
          signal,
        }));
      else if (video.type === "base64") {
        const c = video.data.replace(/\s+/g, "");
        const est =
          Math.floor((c.length * 3) / 4) - (c.endsWith("==") ? 2 : c.endsWith("=") ? 1 : 0);
        if (est > maxOut) throw new Error(`Video (${est} bytes) exceeds ${maxOut} bytes.`);
        const buf = Buffer.from(c, "base64");
        bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      } else bytes = video.data;
      if (!bytes.byteLength) throw new Error("The video model returned an empty video payload.");
      if (bytes.byteLength > maxOut)
        throw new Error(`Video (${bytes.byteLength} bytes) exceeds ${maxOut} bytes.`);
      const mediaType =
        usableType(video.mediaType) ??
        usableType(dlType) ??
        media.detectMediaType(bytes) ??
        "video/mp4";
      const filename = `${baseId}${i ? `-${i}` : ""}${media.extensionForMediaType(mediaType)}`;
      const stored = storage
        ? await storage.put({
            key: `${dir}/${filename}`,
            data: bytes,
            mediaType,
            filename,
            metadata: {
              model: o.modelId,
              sessionId: ctx.session.id,
              ...(o.jobId && { jobId: o.jobId }),
            },
            signal,
          })
        : undefined;
      if (stored) storedKeys.push(stored.key);
      const writtenPath = sandbox && sandboxPath ? media.videoPath(sandboxPath, i) : undefined;
      if (writtenPath)
        await sandbox!.writeBinaryFile({ path: writtenPath, content: bytes, signal });
      if (stored) {
        const { key: storageKey, path: storagePath, ...rest } = stored;
        videos.push({
          ...rest,
          storageKey,
          ...(storagePath && { storagePath }),
          mediaType: usableType(stored.mediaType) ?? mediaType,
          bytes: stored.bytes,
          ...(writtenPath && { path: writtenPath }),
        });
      } else
        videos.push({
          mediaType,
          bytes: bytes.byteLength,
          ...(writtenPath && { path: writtenPath }),
        });
    }
  } catch (error) {
    await cleanupStoredKeys(storage, storedKeys);
    throw error;
  }
  return {
    status: "completed",
    model: o.modelId,
    ...(o.jobId && { jobId: o.jobId }),
    videos,
    ...(o.warnings.length > 0 && { warnings: o.warnings }),
  };
}

async function resolveSandbox(ctx: WorkflowStepToolContext, label: string, allowFallback: boolean) {
  try {
    return { sandbox: await ctx.getSandbox() };
  } catch (error) {
    if (ctx.abortSignal.aborted) throw error;
    const wrapped = new Error(`${label} requires an agent sandbox.`, { cause: error });
    if (allowFallback) return { error: wrapped };
    throw wrapped;
  }
}

const uid = () => `vid_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
const day = () => new Date().toISOString().slice(0, 10);
const tryKey = (raw: string) => {
  try {
    return normalizeStorageKey(raw);
  } catch {
    return undefined;
  }
};
const pos = (v: number, label: string, int = false) => {
  if (!Number.isFinite(v) || v <= 0 || (int && !Number.isInteger(v)))
    throw new Error(`Invalid ${label}: ${v}.`);
  return v;
};
const toAiModel = (model: t.VideoModelLike): AiStartOpts["model"] => {
  const c: object = model;
  return c as AiStartOpts["model"];
};
const readStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const asRecord = (v: unknown) =>
  typeof v === "object" && v !== null ? (v as Readonly<Record<string, unknown>>) : undefined;
const usableType = (v: string | undefined) => {
  const n = v ? media.normalizeMediaType(v) : "";
  return n && n !== "application/octet-stream" ? n : undefined;
};

async function resolvePublicWebhookUrl(candidate: string): Promise<string | undefined> {
  try {
    const parsed = await media.assertSafePublicUrl(candidate, { resolveDns: false });
    const prodHost =
      process.env.VERCEL_ENV === "production"
        ? process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim()
        : undefined;
    if (!prodHost) return parsed.href;
    const prodBase = prodHost.includes("://") ? prodHost : `https://${prodHost}`;
    const prodUrl = new URL(`${parsed.pathname}${parsed.search}`, prodBase);
    return (await media.assertSafePublicUrl(prodUrl.href, { resolveDns: false })).href;
  } catch {
    return undefined;
  }
}

function formatWarnings(warnings: readonly unknown[] | undefined): string[] {
  const out = new Set<string>();
  for (const w of warnings ?? []) {
    const r = asRecord(w);
    const d = readStr(r?.details) ?? readStr(r?.message);
    const p = typeof r?.type === "string" ? WARN_PREFIX[r.type] : undefined;
    const name = readStr(r?.feature) ?? readStr(r?.setting);
    const text =
      typeof w === "string"
        ? w.trim()
        : p
          ? `${p}${name ? ` ${name}` : ""}${d ? `: ${d}` : ""}`
          : (d ?? (r ? JSON.stringify(w) : String(w)));
    if (text) out.add(text);
  }
  return [...out];
}
