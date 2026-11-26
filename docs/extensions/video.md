---
title: "Video Generation"
description: "Generate videos in eve agents with AI SDK and AI Gateway video models, provider-agnostic storage, and sandbox output."
---

`@eve/video` adds video generation to an eve agent. Mounting it adds a `<mount>__generate` tool backed by AI SDK or Vercel AI Gateway video models. It saves output through a provider-agnostic storage interface and adds model instructions that prevent unrequested generations.

## Install and mount

Install `@eve/video` in your agent project (`eve >= 1.5.0`, Node.js `>= 24`):

```bash
pnpm add @eve/video
```

Add a mount file under `agent/extensions/`:

```text
agent/
└── extensions/
    └── video.ts
```

```ts title="agent/extensions/video.ts"
import video from "@eve/video";

export default video({
  // Omit all fields to use google/veo-3.1-fast-generate-001 and automatic storage.
});
```

Mounting at `agent/extensions/video.ts` adds the `video__generate` tool and model instructions. Those instructions tell the model to generate videos only when asked, write visual prompts, and share the returned `url` or sandbox `path`.

String model IDs route through Vercel AI Gateway and require `AI_GATEWAY_API_KEY` or Vercel OIDC credentials. To use a provider without AI Gateway, pass an AI SDK v4 or v3 `VideoModel` instance to `model` or `models`.

## Choose video models

Omit `model` to use `"google/veo-3.1-fast-generate-001"` (`DEFAULT_VIDEO_MODEL`). Configure `model`, `models`, `gateway`, `defaults`, and `providerOptions` on the mount to control which models and parameters calls use:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";

export default video({
  model: "fast", // default alias or model ID
  models: {
    fast: "google/veo-3.1-fast-generate-001",
    quality: "google/veo-3.1-generate-001",
  },
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
    google: { personGeneration: "allow_adult" },
  },
});
```

Model selection follows these rules:

- When `models` is omitted, callers cannot switch models at runtime and must omit `model` or pass the active default model ID.
- When `models` is a string array (for example `["google/veo-3.1-fast-generate-001", "google/veo-3.1-generate-001"]`), callers may request any ID in that allowlist.
- When `models` is an object, keys are aliases for the tool's `model` parameter and values are gateway IDs or AI SDK `VideoModel` instances.
- When `model` is omitted and `models` is configured, the first entry in `models` becomes the default. If `model` matches an alias in `models`, `@eve/video` resolves that alias.
- Pass `gateway` (`apiKey`, `baseURL`, `headers`) to override default AI Gateway credentials or endpoint settings for string model IDs.
- Pass `providerOptions` to forward provider-specific settings to every video model call.

## Configure storage

Video storage solves three constraints:

- Byte-serving models such as Google Veo return inline video bytes instead of a URL, so those bytes need a storage backend or a sandbox `path`.
- URL-serving models return provider-hosted URLs that expire, so copying videos into your own storage prevents broken links.
- Asynchronous AI Gateway start requests cap inline request payloads at 300 KiB. When sandbox inputs exceed 180 KiB and storage returns a public `https://` URL, `@eve/video` stages them (1-day TTL) and removes them afterward.

### Automatic storage selection

When `storage` is omitted, `@eve/video` chooses a storage backend in this order:

| Condition                                                                          | Selected backend                                                                           |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `EVE_VIDEO_BLOB_STORE_ID` or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is set              | `vercelBlob()`                                                                             |
| Running on Vercel (`VERCEL` is set) and `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` | `vercelBlob()`                                                                             |
| Running under `eve dev` (`EVE_DEV=1`)                                              | `localDisk()`                                                                              |
| None of the above                                                                  | None; configure `storage`, pass a sandbox `path`, or set `allowTemporaryProviderUrl: true` |

Set `storage: false` to disable automatic storage selection. Set `allowTemporaryProviderUrl: true` to return expiring provider URLs with `temporary: true` and `expiresAt` when reported. That fallback works only for URL-serving models; byte-serving models still require storage or a sandbox `path`.

### Vercel Blob

Import `vercelBlob` from `@eve/video/vercel` to configure Vercel Blob explicitly:

```ts title="agent/extensions/video.ts"
import video from "@eve/video";
import { vercelBlob } from "@eve/video/vercel";

export default video({
  storage: vercelBlob({
    access: "public", // default; required for staging large sandbox inputs
    prefix: "eve/video", // default
    ttlDays: 30,
  }),
});
```

An explicit `token` option on `vercelBlob({ token })` takes precedence over OIDC. When you configure credentials through environment variables and set `EVE_VIDEO_BLOB_STORE_ID`, OIDC is used if `VERCEL_OIDC_TOKEN` is set or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is absent; otherwise `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is used. When neither `EVE_VIDEO_BLOB_*` variable is set, `@vercel/blob` uses `BLOB_STORE_ID` with OIDC or `BLOB_READ_WRITE_TOKEN`.

`vercelBlob()` stores blobs under `${prefix}/${key}` and returns the unprefixed logical `key`, matching `localDisk()` and `inMemory()`. Uploads larger than 5 MiB use multipart upload automatically unless you set `multipart`.

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

`localDisk()` writes files atomically to disk. `inMemory({ baseUrl?, visibility? })` keeps video bytes in process memory and provides `get`, `delete`, `keys()`, and `clear()` for tests and ephemeral agents.

### Custom storage adapter

Implement `VideoStorage` from `@eve/video/storage` to persist videos to Amazon S3, Cloudflare R2, Google Cloud Storage, or another backend. Only `put` is required; implementing `delete` lets `@eve/video` clean up staged input files and partial multi-video batches on failure:

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
    await client.send(
      new DeleteObjectCommand({
        Bucket: process.env.R2_BUCKET,
        Key: key,
      }),
      { abortSignal: signal },
    );
  },
};
```

Pass `storage: r2VideoStorage` to `video(...)` in `agent/extensions/video.ts`.

## Save videos to a sandbox

When your agent has a [sandbox](/docs/sandbox), `video__generate` can read input media from sandbox paths and write generated videos directly to disk.

- **Inputs (`start`, `end`, `references`):** pass public `https://` URLs or sandbox file paths. `start` and `end` accept PNG, JPEG, WebP, or GIF images. `references` accepts images, videos (MP4, WebM, MOV), or audio (MP3, WAV, OGG, FLAC, M4A). Non-HTTPS URLs, URLs with embedded credentials, and private, loopback, link-local, or metadata hosts are blocked before any request runs.
- **Automatic staging:** for asynchronous models, sandbox inputs totaling over 180 KiB upload to public HTTPS storage (`ttlDays: 1`) before the request and are removed afterward.
- **Output (`path`):** pass `path` (for example `output/clip.mp4`) in the tool call to save videos into the sandbox. When `n` is greater than `1`, `@eve/video` writes `output/clip.mp4`, `output/clip-1.mp4`, `output/clip-2.mp4`, and so on.

Storage and sandbox `path` work together: when both are present, `@eve/video` writes the video to both locations and returns both `url` and `path`. To write only to the sandbox, set `storage: false` in the extension config.

## Require approval and set limits

Video models bill per second and can take several minutes. Gate calls behind [human approval](/docs/tools) and cap duration, batch count, and media sizes before submitting paid jobs:

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

When you pass an approval policy such as `always()`, `@eve/video` formats an approval prompt with the model, video settings, count, sandbox path, and up to 300 characters of the prompt. Only the person who requested the action can respond by default. Pass a full `ApprovalConfiguration` object to customize `prompt` or `response`.

To customize the tool definition itself, override it in a [directory mount](/docs/extensions#override-a-contribution) using `generate` from `@eve/video/tools`:

```ts title="agent/extensions/video/tools/generate.ts"
import { generate } from "@eve/video/tools";
import { defineTool } from "eve/tools";

export default defineTool({
  ...generate,
  description: "Generate a short product demo video when the user asks for one.",
});
```

You can also re-export `generate` from `@eve/video/tools` inside `agent/tools/` without mounting the extension. It reads extension config lazily and falls back to default settings when no mount is present.

## Run as a background workflow task

The default `video__generate` tool polls in-process and keeps the tool call open until generation finishes (up to `poll.timeoutMs`, 10 minutes by default). To let the conversation continue while the video renders—and pause between checks without holding compute across restarts and redeploys—define a [background workflow task](/docs/tools/workflows#run-calls-as-tasks-task) with `defineWorkflowTool`, `sleep` from `eve/workflow`, and `@eve/video/core`:

```ts title="agent/tools/generate_video.ts"
import {
  checkVideoJob,
  persistVideos,
  startVideoJob,
  type GenerateVideoToolInput,
} from "@eve/video/core";
import { vercelBlob } from "@eve/video/vercel";
import { defineWorkflowTool } from "eve/tools";
import { sleep } from "eve/workflow";
import { z } from "zod";

export default defineWorkflowTool({
  description: "Generate a video in the background and return the stored URL.",
  inputSchema: z.object({
    prompt: z.string().min(1),
    duration: z.number().positive().optional(),
    aspectRatio: z.string().optional(),
  }),
  async task(input, ctx) {
    "use workflow";
    const handle = await startStep(input, `${ctx.session.id}:${ctx.callId}`);

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await sleep("5s");
      const result = await pollAndPersistStep({
        modelId: handle.modelId,
        operation: handle.operation,
        jobId: handle.jobId,
        sessionId: ctx.session.id,
      });
      if (result.status === "error") {
        throw new Error(result.error);
      }
      if (result.status === "completed") {
        return result;
      }
    }

    throw new Error("Video generation timed out.");
  },
});

async function startStep(input: GenerateVideoToolInput, idempotencyKey: string) {
  "use step";
  return startVideoJob({ input, storage: vercelBlob(), idempotencyKey });
}

async function pollAndPersistStep(options: {
  modelId: string;
  operation: unknown;
  jobId?: string;
  sessionId: string;
}) {
  "use step";
  const status = await checkVideoJob({
    modelId: options.modelId,
    operation: options.operation,
  });
  if (status.status === "pending") {
    return { status: "pending" as const };
  }
  if (status.status === "error") {
    return { status: "error" as const, error: status.error };
  }
  const videos = await persistVideos({
    videos: status.videos,
    modelId: options.modelId,
    storage: vercelBlob(),
    jobId: options.jobId,
    sessionId: options.sessionId,
    providerExpiresAt: status.expiresAt,
  });
  return { status: "completed" as const, model: options.modelId, videos };
}
```

Running `checkVideoJob` and `persistVideos` inside the same `"use step"` keeps large video bytes out of workflow history so only the saved metadata returns to the workflow body.

When `startVideoJob` stages local sandbox inputs larger than 180 KiB, it returns their keys in `handle.stagedInputKeys`. `generateVideos` and the `generate` tool clean up staged inputs automatically after generation finishes, whereas `startVideoJob` deletes them only on submission failure. Delete `handle.stagedInputKeys` through `storage.delete` once `checkVideoJob` finishes.

To receive provider completion webhooks instead of polling, pass a public `https://` `webhookUrl` to `startVideoJob`. Save `handle.webhookSigningSecret` from the returned handle and pass it to `verifyGatewayWebhookSignature({ header, rawBody, secret, maxAgeSeconds? })` from `@eve/video/core` in your webhook handler. It verifies the `x-ai-gateway-signature` header against the exact raw request body using HMAC-SHA256 in constant time with a 300-second default replay window.

## Configuration reference

### Extension options (`@eve/video`)

| Option                      | Type                                                                          | Default                                                                    | Description                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `model`                     | `string \| VideoModelLike`                                                    | First entry of `models`, or `google/veo-3.1-fast-generate-001`             | Default gateway model ID, alias from `models`, or AI SDK v4/v3 `VideoModel` instance.                          |
| `models`                    | `readonly string[] \| Record<string, string \| VideoModelLike>`               | None (switching disabled)                                                  | Allowlist of gateway model IDs or alias map available to tool calls.                                           |
| `storage`                   | `VideoStorage \| false`                                                       | Auto-selected                                                              | External storage adapter, or `false` to disable automatic storage selection.                                   |
| `gateway`                   | `{ apiKey?: string; baseURL?: string; headers?: Record<string, string> }`     | Default AI Gateway credentials                                             | Custom Vercel AI Gateway connection options for string model IDs.                                              |
| `defaults`                  | `{ aspectRatio?, resolution?, duration?, audio?, fps? }`                      | None                                                                       | Default generation parameters applied when a tool call omits them.                                             |
| `poll`                      | `{ intervalMs?: number; timeoutMs?: number }`                                 | `intervalMs: 5000`, `timeoutMs: 600000`                                    | Asynchronous polling interval (`0`–`60000` ms) and timeout (`100`–`7200000` ms).                               |
| `limits`                    | `{ maxDurationSeconds?, maxVideosPerCall?, maxInputBytes?, maxOutputBytes? }` | `maxVideosPerCall: 4`, `maxInputBytes: 100 MiB`, `maxOutputBytes: 512 MiB` | Validation caps checked before submitting jobs or downloading output. `maxDurationSeconds` has no default cap. |
| `approval`                  | `Approval<GenerateVideoToolInput>`                                            | None                                                                       | Approval policy or configuration gating `generate` tool execution.                                             |
| `providerOptions`           | `Record<string, Record<string, unknown>>`                                     | None                                                                       | Provider-specific options forwarded to the underlying video model call.                                        |
| `allowTemporaryProviderUrl` | `boolean`                                                                     | `false`                                                                    | Return expiring provider URLs when neither storage nor a sandbox `path` is available.                          |

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

| Parameter     | Type       | Required | Description                                                                                             |
| ------------- | ---------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `prompt`      | `string`   | Yes      | Visual description of the video: subject, action, camera movement, lighting, style, and audio/dialogue. |
| `start`       | `string`   | No       | Opening frame image as a public `https://` URL or sandbox file path.                                    |
| `end`         | `string`   | No       | Closing frame image as a public `https://` URL or sandbox file path.                                    |
| `references`  | `string[]` | No       | Reference images, videos, or audio clips as public `https://` URLs or sandbox file paths.               |
| `duration`    | `number`   | No       | Target duration in seconds.                                                                             |
| `aspectRatio` | `string`   | No       | Aspect ratio such as `"16:9"`, `"9:16"`, `"1:1"`, or `"auto"`.                                          |
| `resolution`  | `string`   | No       | Output resolution: `"480p"`, `"720p"`, `"1080p"`, `"4k"`, or `"widthxheight"` such as `"1280x720"`.     |
| `audio`       | `boolean`  | No       | Generate synchronized audio alongside the video.                                                        |
| `n`           | `number`   | No       | Number of video variations to generate. Defaults to `1`; capped by `limits.maxVideosPerCall`.           |
| `fps`         | `number`   | No       | Target frame rate in frames per second.                                                                 |
| `seed`        | `number`   | No       | Integer seed for reproducible output when supported by the model.                                       |
| `model`       | `string`   | No       | Model ID or alias from `models`. Omit to use the configured default model.                              |
| `path`        | `string`   | No       | Sandbox file path where generated videos are written.                                                   |

### Tool output (`GenerateVideoToolOutput`)

While running, `video__generate` yields progress updates with `status` set to `"starting"`, `"generating"` (with `elapsedSeconds` and `attempt`), and `"saving"` (with `videoCount`). On completion it returns `{ status: "completed", model, jobId?, videos, warnings? }`, where each item in `videos` includes `mediaType`, `bytes`, and the destination fields that apply (`url`, `downloadUrl`, `storageKey`, `storagePath`, `path`, `visibility`, `expiresAt`, `temporary`).

`bytes` is `0` when video bytes are not downloaded locally, such as when `temporary: true` returns a provider URL or when the provider delivers directly to caller-managed storage (`uploaded`). For `vercelBlob()`, `storageKey` is the unprefixed logical `key` (matching `localDisk()` and `inMemory()`), while the blob pathname in Vercel Blob is `${prefix}/${key}`.

## Related

- [Extensions](/docs/extensions): mount, configure, and override extension packages
- [Tools](/docs/tools): static tools, approval policies, and tool outputs
- [Workflows as tools](/docs/tools/workflows): write background `task` tools that pause without holding compute
- [Tasks](/docs/tools/tasks): understand how models wait for and cancel background tasks
- [Package README](https://github.com/vercel/eve/tree/main/packages/eve-video): entry points and local validation commands
