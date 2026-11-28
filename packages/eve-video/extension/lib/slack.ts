import {
  defineSlackRenderer,
  type SlackEventContext,
  type SlackRenderer,
} from "eve/channels/slack";
import { call } from "eve/events";

import { assertSafePublicUrl, extensionForMediaType } from "./media.ts";
import { resolveConfiguredStorage } from "./storage/default.ts";
import type { VideoStorage } from "./storage/types.ts";

const DEFAULT_MAX_UPLOAD_BYTES = 100 * 1024 * 1024;
const MAX_TRACKED_CALLS = 200;
const STATE_KEY = "__eveVideoSlack";

interface PendingVideo {
  readonly storageKey: string;
  readonly mediaType?: string;
  readonly bytes?: number;
  readonly fileId?: string;
  readonly filename?: string;
}

interface PendingCall {
  readonly callId: string;
  readonly videos: readonly PendingVideo[];
}

interface SlackVideoState {
  uploaded: string[];
  pending: PendingCall[];
}

/** Options for {@link slackVideoRenderer}. */
export interface SlackVideoRendererOptions {
  /** Storage adapter used to read generated videos. Defaults to automatic storage selection. */
  readonly storage?: VideoStorage;
  /** Extension mount name used to derive `<mount>__generate`. Defaults to `"video"`. */
  readonly mount?: string;
  /** Exact tool name to observe. Overrides `mount` when set. */
  readonly toolName?: string;
  /** When to upload completed videos: `"after-reply"` (default) or `"immediate"`. */
  readonly timing?: "after-reply" | "immediate";
  /** Maximum video size in bytes to upload to Slack. Defaults to 100 MiB. */
  readonly maxBytes?: number;
  /** Optional callback invoked when reading or uploading a generated video fails. */
  readonly onError?: (
    error: unknown,
    context: { readonly callId: string; readonly storageKey: string },
  ) => void;
}

/** Creates a Slack renderer that uploads completed `@eve/video` clips inline to the Slack thread. */
export function slackVideoRenderer(options: SlackVideoRendererOptions = {}): SlackRenderer {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_UPLOAD_BYTES;
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
    throw new RangeError("maxBytes must be a positive number.");
  }
  const targetTool = options.toolName?.trim() || `${options.mount?.trim() || "video"}__generate`;
  const timing = options.timing ?? "after-reply";

  const prestage = async (
    channel: SlackEventContext,
    videos: readonly PendingVideo[],
  ): Promise<PendingVideo[]> => {
    const storage = options.storage ?? resolveConfiguredStorage(undefined);
    if (
      !storage?.get ||
      channel.slack.codeChannel ||
      typeof channel.slack.request !== "function" ||
      !channel.slack.channelId
    ) {
      return [...videos];
    }
    const staged: PendingVideo[] = [];
    for (const item of videos) {
      if (typeof item.bytes === "number" && item.bytes > maxBytes) continue;
      try {
        const stored = await storage.get({
          key: item.storageKey,
          signal: AbortSignal.timeout(30_000),
        });
        if (!stored || !stored.data.byteLength || stored.data.byteLength > maxBytes) continue;
        const filename = videoFilename(item.storageKey, stored.mediaType || item.mediaType);
        const fileId = await preuploadToSlack(channel, stored.data, filename);
        staged.push(fileId ? { ...item, fileId, filename } : item);
      } catch {
        staged.push(item);
      }
    }
    return staged;
  };

  const stateKey = `${STATE_KEY}:${targetTool}`;

  const flush = async (channel: SlackEventContext): Promise<void> => {
    const state = videoState(channel, stateKey);
    if (!state.pending.length) return;
    const batch = state.pending.splice(0, state.pending.length);
    const storage = options.storage ?? resolveConfiguredStorage(undefined);
    for (const entry of batch) {
      if (state.uploaded.includes(entry.callId)) continue;
      state.uploaded.push(entry.callId);
      if (state.uploaded.length > MAX_TRACKED_CALLS) {
        state.uploaded.splice(0, state.uploaded.length - MAX_TRACKED_CALLS);
      }
      const ready = entry.videos.filter(
        (v): v is PendingVideo & { readonly fileId: string; readonly filename: string } =>
          typeof v.fileId === "string" && typeof v.filename === "string",
      );
      let remaining: readonly PendingVideo[] = entry.videos;
      if (
        ready.length > 0 &&
        typeof channel.slack.request === "function" &&
        channel.slack.channelId
      ) {
        const completed = await completeSlackUpload(channel, ready);
        if (completed) {
          remaining = entry.videos.filter((v) => !v.fileId);
        }
      }
      if (!remaining.length || !storage?.get) continue;
      for (const item of remaining) {
        if (typeof item.bytes === "number" && item.bytes > maxBytes) continue;
        try {
          const stored = await storage.get({
            key: item.storageKey,
            signal: AbortSignal.timeout(30_000),
          });
          if (!stored || !stored.data.byteLength || stored.data.byteLength > maxBytes) continue;
          const filename = videoFilename(item.storageKey, stored.mediaType || item.mediaType);
          const data = Buffer.from(
            stored.data.buffer,
            stored.data.byteOffset,
            stored.data.byteLength,
          );
          await channel.slack.uploadFiles([{ data, filename }]);
        } catch (error) {
          options.onError?.(error, { callId: entry.callId, storageKey: item.storageKey });
        }
      }
    }
  };

  return defineSlackRenderer({
    events: {
      async "call.settled"(fact, ctx, next) {
        await next();
        const observed = call(ctx.view, fact.data.callId);
        if (
          observed?.kind !== "tool" ||
          observed.name !== targetTool ||
          observed.outcome !== "completed"
        ) {
          return;
        }
        const videos = extractVideos(observed.output);
        if (!videos.length) return;
        const state = videoState(ctx.channel, stateKey);
        if (
          state.uploaded.includes(fact.data.callId) ||
          state.pending.some((p) => p.callId === fact.data.callId)
        ) {
          return;
        }
        if (timing === "immediate") {
          state.pending.push({ callId: fact.data.callId, videos });
          await flush(ctx.channel);
          return;
        }
        const staged = await prestage(ctx.channel, videos);
        if (staged.length) state.pending.push({ callId: fact.data.callId, videos: staged });
      },
      async "content.completed"(fact, ctx, next) {
        await next();
        if (fact.data.kind !== "text" || fact.data.phase !== "reply") return;
        await flush(ctx.channel);
      },
      async "turn.settled"(_fact, ctx, next) {
        await next();
        await flush(ctx.channel);
      },
      async "session.ended"(_fact, ctx, next) {
        await next();
        await flush(ctx.channel);
      },
    },
  });
}

async function preuploadToSlack(
  channel: SlackEventContext,
  data: Uint8Array,
  filename: string,
): Promise<string | undefined> {
  const init = await channel.slack.request("files.getUploadURLExternal", {
    filename,
    length: data.byteLength,
  });
  if (init.ok !== true) return undefined;
  const uploadUrl = Reflect.get(init, "upload_url");
  const fileId = Reflect.get(init, "file_id");
  if (typeof uploadUrl !== "string" || typeof fileId !== "string" || !fileId.trim()) {
    return undefined;
  }
  const safe = await assertSafePublicUrl(uploadUrl, { resolveDns: false });
  if (safe.hostname !== "slack.com" && !safe.hostname.endsWith(".slack.com")) return undefined;
  const body = Uint8Array.from(data);
  const res = await fetch(safe.href, {
    method: "POST",
    body,
    headers: { "content-type": "application/octet-stream" },
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  return res.ok ? fileId.trim() : undefined;
}

async function completeSlackUpload(
  channel: SlackEventContext,
  ready: readonly { readonly fileId: string; readonly filename: string }[],
): Promise<boolean> {
  try {
    const res = await channel.slack.request("files.completeUploadExternal", {
      channel_id: channel.slack.channelId,
      files: ready.map((item) => ({ id: item.fileId, title: item.filename })),
      ...(channel.slack.threadTs && { thread_ts: channel.slack.threadTs }),
    });
    return res.ok === true;
  } catch {
    return false;
  }
}

function videoState(channel: SlackEventContext, key: string): SlackVideoState {
  const existing = Reflect.get(channel.state, key);
  if (isSlackVideoState(existing)) return existing;
  const fresh: SlackVideoState = { uploaded: [], pending: [] };
  Reflect.set(channel.state, key, fresh);
  return fresh;
}

function isSlackVideoState(value: unknown): value is SlackVideoState {
  if (typeof value !== "object" || value === null) return false;
  return (
    Array.isArray(Reflect.get(value, "uploaded")) && Array.isArray(Reflect.get(value, "pending"))
  );
}

function extractVideos(output: unknown): PendingVideo[] {
  if (typeof output !== "object" || output === null) return [];
  const raw = Reflect.get(output, "videos");
  if (!Array.isArray(raw)) return [];
  const videos: PendingVideo[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const storageKey = Reflect.get(item, "storageKey");
    if (typeof storageKey !== "string" || !storageKey.trim()) continue;
    const mediaType = Reflect.get(item, "mediaType");
    const bytes = Reflect.get(item, "bytes");
    videos.push({
      storageKey: storageKey.trim(),
      ...(typeof mediaType === "string" && { mediaType }),
      ...(typeof bytes === "number" && { bytes }),
    });
  }
  return videos;
}

function videoFilename(storageKey: string, mediaType: string | undefined): string {
  const ext = mediaType ? extensionForMediaType(mediaType) : ".mp4";
  const last = storageKey.split("/").pop()?.trim() ?? "";
  if (!last) return `video${ext}`;
  return /\.(mp4|mov|webm)$/i.test(last) ? last : `${last}${ext}`;
}
