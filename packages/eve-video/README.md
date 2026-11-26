# @eve/video

`@eve/video` adds video generation to an eve agent through AI SDK and Vercel AI Gateway video models, with provider-agnostic storage, sandbox input and output support, and model-facing guidance.

## Install and mount

Install `@eve/video` in an eve agent project (`eve >= 1.5.0`, Node.js `>= 24`):

```sh
pnpm add @eve/video
```

Mount the extension under `agent/extensions/`:

```ts
// agent/extensions/video.ts
import video from "@eve/video";

export default video({});
```

Mounting as `video.ts` adds the `video__generate` tool and appends instructions telling the model to generate videos only when explicitly asked.

Default string model IDs route through Vercel AI Gateway (`AI_GATEWAY_API_KEY` or Vercel OIDC). You can also pass an AI SDK v4 or v3 `VideoModel` instance directly.

## Entry points

- `@eve/video`: default export (`video`) extension factory.
- `@eve/video/tools`: `generate` tool definition for overrides or standalone registration. Reads `extension.config` lazily and falls back to defaults without a mount.
- `@eve/video/storage`: `localDisk()`, `inMemory()`, and `VideoStorage` types.
- `@eve/video/vercel`: `vercelBlob()` storage adapter and `VercelBlobVideoStorageOptions`.
- `@eve/video/core`: `generateVideos`, `startVideoJob`, `checkVideoJob`, `persistVideos`, `verifyGatewayWebhookSignature`, `DEFAULT_VIDEO_MODEL`, and TypeScript types.

## Model selection

Omit `model` to use `"google/veo-3.1-fast-generate-001"`. Pass `model` to change the default, `models` to allow runtime switching by gateway ID or named alias, `gateway` to override AI Gateway settings, and `providerOptions` for provider-specific fields:

```ts
// agent/extensions/video.ts
import video from "@eve/video";

export default video({
  model: "fast",
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

When `models` is omitted, callers cannot switch models at runtime.

## Storage

When `storage` is omitted, `@eve/video` selects a backend automatically:

1. `EVE_VIDEO_BLOB_STORE_ID` or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` set -> `vercelBlob()`
2. Running on Vercel (`VERCEL` set) with `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` set -> `vercelBlob()`
3. Running under `eve dev` (`EVE_DEV=1`) -> `localDisk()` (writes to `<tmpdir>/eve-videos`)
4. Otherwise -> no automatic storage; configure `storage`, pass a sandbox `path` per call, or set `allowTemporaryProviderUrl: true` (URL-serving models only)

Set `storage: false` to disable automatic storage selection.

### Built-in and custom adapters

- `vercelBlob(options?)` from `@eve/video/vercel`: defaults to `access: "public"`, `prefix: "eve/video"`, and automatic multipart upload above 5 MiB. Supports `token`, `oidcToken`, `storeId`, `ttlDays`, `cacheControlMaxAge`, `addRandomSuffix`, and `allowOverwrite`. An explicit `token` option takes precedence over OIDC; with env vars, `EVE_VIDEO_BLOB_STORE_ID` uses OIDC when `VERCEL_OIDC_TOKEN` is set or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` is absent, and otherwise `@vercel/blob` falls back to `BLOB_STORE_ID` + OIDC or `BLOB_READ_WRITE_TOKEN`. Stored blobs live under `${prefix}/${key}` while `put` returns the unprefixed logical `key`.
- `localDisk(options?)` from `@eve/video/storage`: atomic writes to `directory` (defaults to `<tmpdir>/eve-videos`), optional `publicBaseUrl`.
- `inMemory(options?)` from `@eve/video/storage`: in-memory adapter with `get`, `delete`, `keys()`, and `clear()` for tests and ephemeral runs.
- Custom `VideoStorage`: implement `put(input)` returning `{ key, mediaType, bytes, url?, downloadUrl?, path?, visibility?, expiresAt? }`, plus optional `get` and `delete`.

```ts
import type { VideoStorage } from "@eve/video/storage";

const customStorage: VideoStorage = {
  async put({ key, data, mediaType, signal }) {
    await uploadBytes(key, data, mediaType, signal);
    return {
      key,
      url: `https://media.example.com/${key}`,
      mediaType,
      bytes: data.byteLength,
      visibility: "public",
    };
  },
  async delete({ key, signal }) {
    await deleteBytes(key, signal);
  },
};
```

## Sandbox inputs and `path` saving

The `generate` tool reads `start`, `end`, and `references` from public `https://` URLs or agent sandbox file paths. For asynchronous models, local sandbox files totaling over 180 KiB are staged automatically to public HTTPS storage (with a 1-day TTL) and removed after generation finishes.

Pass `path` to save generated videos into the agent sandbox. Multiple outputs (`n > 1`) write `clip.mp4`, `clip-1.mp4`, `clip-2.mp4`, and so on.

## Approval and limits

Gate paid video generations behind human approval and cap request sizes before submitting jobs:

```ts
// agent/extensions/video.ts
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

Defaults: `maxVideosPerCall: 4`, `maxInputBytes: 100 MiB`, `maxOutputBytes: 512 MiB`, `maxDurationSeconds`: unlimited.

## Background workflow task

Use `@eve/video/core` with `defineWorkflowTool({ task })` and `sleep` from `eve/workflow` when video generation should run in the background without holding compute and survive restarts and redeploys:

```ts
// agent/tools/generate_video.ts
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

To receive push completion notifications instead of polling, pass `webhookUrl` to `startVideoJob`, store `handle.webhookSigningSecret`, and verify incoming `x-ai-gateway-signature` headers with `verifyGatewayWebhookSignature({ header, rawBody, secret: handle.webhookSigningSecret })` from `@eve/video/core`.

When `startVideoJob` stages local sandbox inputs larger than 180 KiB, it returns their keys in `handle.stagedInputKeys`. `generateVideos` and the `generate` tool delete staged inputs automatically when generation finishes, whereas `startVideoJob` deletes them only on submission failure; delete `handle.stagedInputKeys` with `storage.delete` after `checkVideoJob` finishes.

See [`docs/extensions/video.md`](../../docs/extensions/video.md) for full configuration and tool reference.

## Validate

```sh
pnpm --filter @eve/video typecheck
pnpm --filter @eve/video build
pnpm --filter @eve/video test:unit
pnpm --filter @eve/video test:integration
```
