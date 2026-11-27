---
title: "Video Generation"
description: "Generate, edit, and extend videos in eve agents with a durable background workflow task, webhook-first delivery, provider-agnostic storage, and sandbox output."
---

`@eve/video` adds video generation, editing, and extension to an eve agent. Mounting it adds `<mount>__generate` as a durable background [workflow task](/docs/tools/workflows#run-calls-as-tasks-task) (`defineWorkflowTool({ task })`) backed by AI SDK or Vercel AI Gateway video models. Each call returns a task receipt immediately so the conversation continues while the video renders, suspends without holding serverless compute, survives restarts and redeploys, and delivers the finished video in a `<task_result>` message. Output saves through a provider-agnostic storage interface, and model instructions prevent unrequested generations.

## Install and mount

Install `@eve/video` in your agent project (`eve >= 1.6.0`, Node.js `>= 24`):

```bash
pnpm add @eve/video
```

Add a mount file at `agent/extensions/video.ts`:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";

export default video({
  // Omit all fields to use bytedance/seedance-2.5-flash, webhook: "auto", and automatic storage.
});
```

Mounting at `agent/extensions/video.ts` adds the `video__generate` background workflow task and model instructions. String model IDs route through Vercel AI Gateway and require `AI_GATEWAY_API_KEY` or Vercel OIDC credentials. To use a provider without AI Gateway, pass an AI SDK v4 or v3 `VideoModel` instance to `model`.

## Background execution and webhooks

Each `<mount>__generate` call runs as a `defineWorkflowTool({ task })` workflow run that returns a task receipt right away and delivers the finished video in a `<task_result>` message; the model can wait with `eve__task_wait` or cancel with `eve__task_cancel` (see [Tasks](/docs/tools/tasks)).

- **Webhook-first (`webhook: "auto"`, default):** Uses `createWebhook({ respondWith: "manual" })` when the video model supports native terminal webhooks (such as Vercel AI Gateway models) and the host exposes a public `https://` webhook URL. Callbacks verify `x-ai-gateway-signature` (`401` on invalid signatures, switching to polling after 10 invalid deliveries; `204` on verified deliveries). A 20-second fallback poll runs alongside the webhook so jobs still finish if callbacks are blocked.
- **Durable `sleep()` polling fallback:** Falls back automatically to durable `sleep()` polling (`poll.intervalMs`, default `5000` ms; `poll.timeoutMs`, default `600000` ms) in local `eve dev`, for direct provider models without native terminal webhooks (such as `@ai-sdk/google` or `@ai-sdk/klingai`), or when `webhook: "never"` is set.
- **Single-step models:** Models that implement only `doGenerate` (without `doStart` and `doStatus`) complete inside a single `"use step"`.
- **Payload boundary and cleanup:** Completed videos download and persist inside the same `"use step"` as the terminal status check so multi-megabyte video bytes never cross the Workflow step boundary. Large local inputs (> 180 KiB) stage to public HTTPS storage (`ttlDays: 1`) and are deleted in `finally`, including on cancel or timeout.

## Choose a video model

Omit `model` to use `"bytedance/seedance-2.5-flash"`, which supports text-to-video, `start`/`end` frames, `references`, audio, video editing, and video extension out of the box. Configure `model`, `gateway`, `defaults`, and `providerOptions` on the mount to choose a different model or tune default parameters:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";

export default video({
  model: "bytedance/seedance-2.5",
  defaults: {
    aspectRatio: "16:9",
    resolution: "720p",
    duration: 6,
    audio: true,
  },
  gateway: {
    apiKey: process.env.AI_GATEWAY_API_KEY,
  },
  providerOptions: {
    bytedance: { pollTimeoutMs: 600_000 },
  },
});
```

To expose more than one video model, mount `@eve/video` at separate paths (for example, `agent/extensions/video.ts` and `agent/extensions/video-hq.ts`), which gives each model its own tool name.

## Iterate on a video

To edit or extend a video produced earlier in the same session, call `<mount>__generate` again with `video` set to the earlier video's returned `url`, `storageKey` (when configured storage implements `get`, such as `localDisk()` or `inMemory()`), or sandbox `path`:

- **Default (edit in place):** omit `extend` to modify the existing video according to `prompt`. `@eve/video` omits `duration` and `aspectRatio` (including values from `defaults`) across all models so in-place edits match the source clip and don't trip provider parameter checks.
- **Extend (`extend: true`):** continues the video from its last frame according to `prompt`, keeping `duration` for the extension segment.

`video` cannot be combined with `start` or `end`, and `extend: true` requires `video`. `@eve/video` automatically translates `video` and `extend` to the active provider's native API:

- **`bytedance/seedance-2.5-flash` and `bytedance/seedance-2.5` (default):** prepends `video` as the first entry of `inputReferences` (before any additional `references`) and omits `aspectRatio` (including from `defaults`) on extensions as well as edits.
- **`spacexai/grok-imagine-video` (and direct xAI models):** forwards `video` via `providerOptions.xai.videoUrl` and sets `mode: "extend-video"` when `extend: true`. On edit, `resolution` is also omitted because Grok rejects it. Local bytes are auto-staged to a public `https://` URL when public HTTPS storage is configured; otherwise pass an `https://` URL.
- **`bfl/flux-3-video`, `topaz/*`, and other models:** prepends `video` as the first entry of `inputReferences` with explicit `mediaType`, staging large local inputs to public HTTPS storage on AI Gateway async models.
- **Generation-only models (such as Google Veo):** iterate by generating a new take with a refined `prompt`, optionally reusing `seed`, `start`, `end`, or image `references`.

## Configure storage

Video storage handles byte-serving models (such as Google Veo, which return inline bytes rather than URLs), persists videos past expiring provider URLs, and stages local inputs over 180 KiB (and local Grok edit/extend videos) so async AI Gateway requests stay under their 300 KiB inline body limit.

### Automatic storage selection

When `storage` is omitted, `@eve/video` chooses a storage backend in this order:

| Condition                                                                          | Selected backend                                               |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `EVE_VIDEO_BLOB_STORE_ID` or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is set              | `vercelBlob()`                                                 |
| Running on Vercel (`VERCEL` is set) and `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` | `vercelBlob()`                                                 |
| Running under `eve dev` (`EVE_DEV=1`)                                              | `localDisk()`                                                  |
| None of the above                                                                  | None; configure `storage` or pass a sandbox `path` on the call |

Set `storage: false` to disable automatic storage selection (for example, to write only to a sandbox `path`).

### Vercel Blob

Import `vercelBlob` from `@eve/video/vercel` to configure Vercel Blob explicitly:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";
import { vercelBlob } from "@eve/video/vercel";

export default video({
  storage: vercelBlob({
    access: "public", // default; required for staging large local inputs
    prefix: "eve/video", // default
    ttlDays: 30,
  }),
});
```

An explicit `token` option takes precedence over OIDC. With environment variables, `EVE_VIDEO_BLOB_STORE_ID` uses OIDC when `VERCEL_OIDC_TOKEN` is set or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is absent; otherwise `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is used, and when neither `EVE_VIDEO_BLOB_*` variable is set, `@vercel/blob` falls back to `BLOB_STORE_ID` + OIDC or `BLOB_READ_WRITE_TOKEN`. Blobs are stored under `${prefix}/${key}` while `put` returns the unprefixed logical `key`. Uploads over 5 MiB use multipart automatically unless `multipart` is set.

### Local disk and in-memory storage

Import `localDisk` or `inMemory` from `@eve/video/storage` for local development, self-hosted file serving, or tests:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";
import { localDisk } from "@eve/video/storage";

export default video({
  storage: localDisk({
    directory: "./data/videos", // defaults to <tmpdir>/eve-videos
    publicBaseUrl: "https://media.example.com/videos",
  }),
});
```

`localDisk()` writes files atomically and implements `get` and `delete`. `inMemory({ baseUrl?, visibility? })` keeps video bytes in memory and exposes `get`, `delete`, `keys()`, and `clear()`.

### Custom storage adapter

Implement `VideoStorage` from `@eve/video/storage` to persist videos to Amazon S3, Cloudflare R2, Google Cloud Storage, or another backend. Only `put` is required; implementing `get` lets callers iterate by `storageKey`, and implementing `delete` lets `@eve/video` clean up staged inputs and partial batches on failure:

```ts title="agent/lib/r2-video-storage.ts"
import type { VideoStorage } from "@eve/video/storage";
import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

const client = new S3Client({ region: "auto", endpoint: process.env.R2_ENDPOINT });

export const r2VideoStorage: VideoStorage = {
  async put({ key, data, mediaType, signal }) {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
        Body: data,
        ContentType: mediaType,
      }),
      { abortSignal: signal },
    );
    return {
      key,
      url: `https://media.example.com/${key}`,
      mediaType,
      bytes: data.byteLength,
      visibility: "public",
    };
  },
  async delete({ key, signal }) {
    await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET, Key: key }), {
      abortSignal: signal,
    });
  },
};
```

Pass `storage: r2VideoStorage` to `video(...)` in `agent/extensions/video.ts`.

## Save videos to a sandbox

When your agent has a [sandbox](/docs/sandbox), `video__generate` can read input media from sandbox paths and write generated videos directly to disk.

- **Inputs (`video`, `start`, `end`, `references`):** pass public `https://` URLs, sandbox file paths, or a `storageKey` when configured storage implements `get`. `video` accepts videos (MP4, WebM, MOV); `start` and `end` accept images (PNG, JPEG, WebP, GIF); `references` accepts images, videos, or audio (MP3, WAV, OGG, FLAC, M4A). Non-HTTPS URLs, embedded credentials, and private, loopback, link-local, or metadata hosts are blocked before any request runs.
- **Automatic staging:** for AI Gateway asynchronous models, local inputs that would exceed the inline request budget (and any local bytes passed to Grok edit/extend) upload incrementally to public HTTPS storage (`ttlDays: 1`) before the request and are deleted in `finally` when the task ends. Direct provider models (such as `@ai-sdk/google`) keep local inputs inline.
- **Output (`path`):** pass `path` (for example `output/clip.mp4`) to save videos into the sandbox. When `n > 1`, `@eve/video` writes `output/clip.mp4`, `output/clip-1.mp4`, and so on. When both storage and `path` are present, `@eve/video` writes to both and returns both `url` and `path`; set `storage: false` to write only to the sandbox.

## Require approval and set limits

Video models bill per second and can take several minutes. Gate calls behind [human approval](/docs/tools) and cap duration, batch count, and media sizes directly on the mount:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";
import { always } from "eve/tools/approval";

export default video({
  approval: always(),
  limits: {
    maxDurationSeconds: 10,
    maxVideosPerCall: 2,
    maxInputBytes: 50 * 1024 * 1024,
    maxOutputBytes: 256 * 1024 * 1024,
  },
});
```

When you pass an approval policy such as `always()`, `@eve/video` formats an approval prompt with the action (`Generate`, `Edit`, or `Extend`), model, video settings, source `video`, count, sandbox path, and up to 300 characters of the prompt. Pass a full `ApprovalConfiguration` object to customize `prompt` or `response`.

Because `generate` is a `defineWorkflowTool`, configure `approval`, `defaults`, `limits`, `poll`, and `webhook` directly on `video(...)` rather than spreading `generate` into `defineTool()`. To remove `<mount>__generate`, export `disableTool()` in `agent/extensions/video/tools/generate.ts` (see [Override a contribution](/docs/extensions#override-a-contribution)).

## Play videos inline in Slack

Slack does not render a bare `.mp4` link as an inline player. Add `slackVideoRenderer()` from `@eve/video/slack` to your Slack channel's `renderers` so completed videos upload directly to the thread via `files.uploadV2`:

```ts title="agent/channels/slack.ts"
import { slackChannel } from "eve/channels/slack";
import { slackVideoRenderer } from "@eve/video/slack";

export default slackChannel({
  renderers: [slackVideoRenderer()],
});
```

- Uses automatic storage selection by default; pass `{ storage }` when `agent/extensions/video.ts` uses a custom `VideoStorage` adapter.
- Uploads right after the agent's text reply (`timing: "after-reply"`, default) — pre-uploading bytes on `call.settled` while the reply is being written and finalizing via `files.completeUploadExternal` immediately after the reply posts (flushing on `turn.settled` / `session.ended` if no text reply posts). Pass `timing: "immediate"` to publish as soon as `video__generate` finishes.
- Pass `{ mount }` (default `"video"`) or `{ toolName }` when mounted at a different path, `{ maxBytes }` to adjust the 100 MiB upload cap, and `{ onError }` to log upload failures without interrupting replies.

## Configuration reference

### Extension options (`@eve/video`)

| Option            | Type                                                                          | Default                                                                    | Description                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model`           | `string \| VideoModelLike`                                                    | `"bytedance/seedance-2.5-flash"`                                           | Gateway model ID or AI SDK v4/v3 `VideoModel` instance.                                                                                                                  |
| `storage`         | `VideoStorage \| false`                                                       | Auto-selected                                                              | External storage adapter, or `false` to disable automatic storage selection.                                                                                             |
| `gateway`         | `{ apiKey?: string; baseURL?: string; headers?: Record<string, string> }`     | Default AI Gateway credentials                                             | Custom Vercel AI Gateway connection options for string model IDs.                                                                                                        |
| `defaults`        | `{ aspectRatio?, resolution?, duration?, audio?, fps? }`                      | None                                                                       | Default generation parameters applied when a tool call omits them.                                                                                                       |
| `poll`            | `{ intervalMs?: number; timeoutMs?: number }`                                 | `intervalMs: 5000`, `timeoutMs: 600000`                                    | Durable `sleep()` polling interval (`100`–`60000` ms) and timeout (`100`–`7200000` ms) for asynchronous jobs.                                                            |
| `webhook`         | `"auto" \| "never"`                                                           | `"auto"`                                                                   | Uses `createWebhook({ respondWith: "manual" })` when the model supports native terminal webhooks and the host has a public `https://` URL. Set `"never"` to always poll. |
| `limits`          | `{ maxDurationSeconds?, maxVideosPerCall?, maxInputBytes?, maxOutputBytes? }` | `maxVideosPerCall: 4`, `maxInputBytes: 100 MiB`, `maxOutputBytes: 512 MiB` | Validation caps checked before submitting jobs or downloading output. `maxDurationSeconds` has no default cap.                                                           |
| `approval`        | `Approval<GenerateVideoToolInput>`                                            | None                                                                       | Approval policy or configuration gating `generate` tool execution.                                                                                                       |
| `providerOptions` | `Record<string, Record<string, unknown>>`                                     | None                                                                       | Provider-specific options forwarded to the underlying video model call.                                                                                                  |

### Vercel Blob adapter options (`@eve/video/vercel`)

| Option               | Type                    | Default                                                         | Description                                                          |
| -------------------- | ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------- |
| `access`             | `"public" \| "private"` | `"public"`                                                      | Visibility of uploaded video blobs.                                  |
| `token`              | `string`                | `EVE_VIDEO_BLOB_READ_WRITE_TOKEN`, then `BLOB_READ_WRITE_TOKEN` | Vercel Blob read-write token.                                        |
| `oidcToken`          | `string`                | `VERCEL_OIDC_TOKEN` or automatic Vercel OIDC                    | Vercel OIDC token used with `storeId`.                               |
| `storeId`            | `string`                | `EVE_VIDEO_BLOB_STORE_ID`, then `BLOB_STORE_ID`                 | Blob store ID used with Vercel OIDC authentication.                  |
| `prefix`             | `string`                | `"eve/video"`                                                   | Pathname prefix prepended to stored video keys.                      |
| `addRandomSuffix`    | `boolean`               | `false`                                                         | Append a random suffix to uploaded pathnames.                        |
| `allowOverwrite`     | `boolean`               | `true`                                                          | Allow overwriting an existing blob at the same pathname.             |
| `cacheControlMaxAge` | `number`                | None                                                            | `Cache-Control` `max-age` duration in seconds.                       |
| `ttlDays`            | `number`                | None                                                            | Retention period in days before Vercel Blob deletes uploaded videos. |
| `multipart`          | `boolean`               | Automatic above 5 MiB                                           | Force multipart upload on or off.                                    |

### Tool input parameters (`<mount>__generate`)

| Parameter     | Type       | Required | Description                                                                                                            |
| ------------- | ---------- | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `prompt`      | `string`   | Yes      | Visual description of the video to generate, or the edit or continuation to apply to `video`.                          |
| `video`       | `string`   | No       | Existing video to edit or extend: a public `https://` URL, a `storageKey` from an earlier run, or a sandbox file path. |
| `extend`      | `boolean`  | No       | Continue from `video`'s last frame instead of editing in place. Requires `video`.                                      |
| `start`       | `string`   | No       | Opening frame image as a public `https://` URL or sandbox file path. Cannot be combined with `video`.                  |
| `end`         | `string`   | No       | Closing frame image as a public `https://` URL or sandbox file path. Cannot be combined with `video`.                  |
| `references`  | `string[]` | No       | Up to 16 reference images, videos, or audio clips as public `https://` URLs or sandbox file paths.                     |
| `duration`    | `number`   | No       | Target duration in seconds.                                                                                            |
| `aspectRatio` | `string`   | No       | Aspect ratio such as `"16:9"`, `"9:16"`, `"1:1"`, or `"auto"`.                                                         |
| `resolution`  | `string`   | No       | Output resolution: `"480p"`, `"720p"`, `"1080p"`, `"4k"`, or `"widthxheight"` such as `"1280x720"`.                    |
| `audio`       | `boolean`  | No       | Generate synchronized audio alongside the video.                                                                       |
| `n`           | `number`   | No       | Number of video variations to generate. Defaults to `1`; capped by `limits.maxVideosPerCall`.                          |
| `fps`         | `number`   | No       | Target frame rate in frames per second.                                                                                |
| `seed`        | `number`   | No       | Integer seed for reproducible output when supported by the model.                                                      |
| `path`        | `string`   | No       | Sandbox file path where generated videos are written.                                                                  |

### Tool output (`GenerateVideoToolOutput`)

Each `<mount>__generate` call returns a task receipt immediately, and eve delivers the final JSON output in a `<task_result>` message when generation completes. While waiting on an asynchronous job, `video__generate` yields `GenerateVideoToolProgress` updates with `status: "generating"`, `model`, optional `jobId`, `elapsedSeconds`, and `attempt`. On completion it returns `{ status: "completed", model, jobId?, videos, warnings? }`, where each item in `videos` includes `mediaType`, `bytes`, and the destination fields that apply (`url`, `downloadUrl`, `storageKey`, `storagePath`, `path`, `visibility`, `expiresAt`).

`bytes` is `0` when the provider delivers directly to caller-managed storage (`uploaded`). For `vercelBlob()`, `storageKey` is the unprefixed logical `key` (matching `localDisk()` and `inMemory()`), while the blob pathname in Vercel Blob is `${prefix}/${key}`.

## Related

- [Extensions](/docs/extensions): mount, configure, and override extension packages
- [Tools](/docs/tools): static tools, approval policies, and tool outputs
- [Workflows as tools](/docs/tools/workflows): write background `task` tools that pause without holding compute
- [Tasks](/docs/tools/tasks): understand how models wait for and cancel background tasks
- [Package README](https://github.com/vercel/eve/tree/main/packages/eve-video): entry points and local validation commands
