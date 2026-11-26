# @eve/video

`@eve/video` adds video generation, editing, and extension to an eve agent as a durable background workflow task (`defineWorkflowTool({ task })`) backed by AI SDK and Vercel AI Gateway video models, with webhook-first delivery, durable `sleep()` polling fallback, provider-agnostic storage, sandbox input and output support, and model-facing guidance.

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

Mounting as `video.ts` adds `video__generate` as a background workflow task and appends model instructions. Each call returns a task receipt immediately so the conversation continues while the video renders, suspends without holding serverless compute across restarts and redeploys, and delivers the finished video in a `<task_result>` message.

Default string model IDs route through Vercel AI Gateway (`AI_GATEWAY_API_KEY` or Vercel OIDC). You can also pass an AI SDK v4 or v3 `VideoModel` instance directly.

## Entry points

- `@eve/video`: default export (`video`) extension factory.
- `@eve/video/tools`: `generate` workflow tool definition (reads `extension.config` lazily and falls back to defaults without a mount).
- `@eve/video/storage`: `localDisk()`, `inMemory()`, and `VideoStorage` types.
- `@eve/video/vercel`: `vercelBlob()` storage adapter and `VercelBlobVideoStorageOptions`.
- `@eve/video/core`: composable primitives (`startVideoJob`, `checkVideoJob`, `persistVideos`, `verifyGatewayWebhookSignature`, `DEFAULT_VIDEO_MODEL`) and TypeScript types.

## Background execution and webhooks

Asynchronous jobs run webhook-first and fall back to durable `sleep()` polling automatically:

- **`webhook: "auto"` (default):** Uses `createWebhook({ respondWith: "manual" })` whenever the model supports native terminal webhooks (such as Vercel AI Gateway models) and the host exposes a public `https://` webhook URL. Incoming callbacks verify `x-ai-gateway-signature` (`401` on invalid signatures, `204` on verified deliveries), with a 60-second fallback poll in case callbacks are blocked.
- **Durable `sleep()` polling fallback:** Automatically falls back to durable `sleep()` polling (`poll.intervalMs`, default `5000` ms; `poll.timeoutMs`, default `600000` ms) in local `eve dev`, for direct provider models without native terminal webhooks (such as `@ai-sdk/google` or `@ai-sdk/klingai`), or when `webhook: "never"` is configured.
- **Single-step models:** Models that implement only `doGenerate` complete inside a single `"use step"`.
- **Payload boundary and cleanup:** Completed videos download and persist inside the same `"use step"` as the terminal status check so video bytes never cross the Workflow step boundary. Large local inputs (> 180 KiB) stage to public HTTPS storage (`ttlDays: 1`) and are deleted in `finally`.

## Model selection

Omit `model` to use `"google/veo-3.1-fast-generate-001"`. Pass `model` to change the default, `models` to allow runtime switching by gateway ID or named alias, `gateway` to override AI Gateway settings, `webhook` (`"auto" | "never"`) and `poll` to control async completion, and `providerOptions` for provider-specific fields:

```ts
// agent/extensions/video.ts
import video from "@eve/video";

export default video({
  model: "fast",
  models: {
    fast: "google/veo-3.1-fast-generate-001",
    quality: "google/veo-3.1-generate-001",
    edit: "spacexai/grok-imagine-video",
  },
  defaults: { aspectRatio: "16:9", resolution: "720p", duration: 6, audio: true },
  webhook: "auto",
  gateway: { apiKey: process.env.AI_GATEWAY_API_KEY },
  providerOptions: { google: { personGeneration: "allow_adult" } },
});
```

When `models` is omitted, callers cannot switch models at runtime.

## Iterate on a video

Pass an earlier video's `url`, `storageKey` (when storage implements `get`), or sandbox `path` in `video` with `mode: "edit"` (default) to modify it or `mode: "extend"` to continue from its last frame (`video` cannot be combined with `start` or `end`, and `mode` requires `video`):

- `spacexai/grok-imagine-video` (and direct xAI models): routes via `providerOptions.xai.videoUrl` (`mode: "extend-video"` for extension), omits `duration`/`aspectRatio`/`resolution` on edit, and stages local bytes to a public `https://` URL when public HTTPS storage is configured.
- `bytedance/seedance-2.5`, `bfl/flux-3-video`, `topaz/*`, and other models: prepends `video` as the first entry of `inputReferences` (omitting `aspectRatio` on Seedance `extend`).
- Generation-only models (such as Google Veo): iterate by generating a new take with a refined `prompt`, reusing `seed`, `start`, `end`, or image `references`.

## Storage

When `storage` is omitted, `@eve/video` selects a backend automatically:

1. `EVE_VIDEO_BLOB_STORE_ID` or `EVE_VIDEO_BLOB_READ_WRITE_TOKEN` set -> `vercelBlob()`
2. Running on Vercel (`VERCEL` set) with `BLOB_STORE_ID` or `BLOB_READ_WRITE_TOKEN` set -> `vercelBlob()`
3. Running under `eve dev` (`EVE_DEV=1`) -> `localDisk()` (writes to `<tmpdir>/eve-videos`)
4. Otherwise -> no automatic storage; configure `storage`, pass a sandbox `path` per call, or set `allowTemporaryProviderUrl: true` (URL-serving models only)

Set `storage: false` to disable automatic storage selection.

- `vercelBlob(options?)` from `@eve/video/vercel`: defaults to `access: "public"`, `prefix: "eve/video"`, and automatic multipart upload above 5 MiB. Supports `token`, `oidcToken`, `storeId`, `ttlDays`, `cacheControlMaxAge`, `addRandomSuffix`, and `allowOverwrite`. Stored blobs live under `${prefix}/${key}` while `put` returns the unprefixed logical `key`.
- `localDisk(options?)` from `@eve/video/storage`: atomic writes to `directory` (defaults to `<tmpdir>/eve-videos`), optional `publicBaseUrl`, with `get` and `delete`.
- `inMemory(options?)` from `@eve/video/storage`: in-memory adapter with `get`, `delete`, `keys()`, and `clear()` for tests and ephemeral runs.
- Custom `VideoStorage`: implement `put(input)` returning `{ key, mediaType, bytes, url?, downloadUrl?, path?, visibility?, expiresAt? }`, plus optional `get` and `delete`.

## Sandbox inputs and `path` saving

The `generate` tool reads `video`, `start`, `end`, and `references` from public `https://` URLs, agent sandbox file paths, or `storageKey`s when configured storage implements `get`. For asynchronous models, local inputs totaling over 180 KiB (and local Grok edit/extend inputs) stage to public HTTPS storage (`ttlDays: 1`) and are deleted in `finally`.

Pass `path` to save generated videos into the agent sandbox. Multiple outputs (`n > 1`) write `clip.mp4`, `clip-1.mp4`, `clip-2.mp4`, and so on.

## Approval, limits, and overrides

Gate paid video generations behind human approval and cap request sizes directly on the mount:

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

Defaults: `maxVideosPerCall: 4`, `maxInputBytes: 100 MiB`, `maxOutputBytes: 512 MiB`, `maxDurationSeconds`: unlimited. Configure `approval` directly via `video({ approval: always() })` rather than spreading `generate` into `defineTool()`. To remove `<mount>__generate`, export `disableTool()` in `agent/extensions/video/tools/generate.ts`.

## Programmatic API (`@eve/video/core`)

Use `startVideoJob`, `checkVideoJob`, `persistVideos`, `verifyGatewayWebhookSignature`, and `DEFAULT_VIDEO_MODEL` from `@eve/video/core` when building custom pipelines, specialized workflow tools, or standalone webhook routes. Delete any `handle.stagedInputKeys` returned by `startVideoJob` via `storage.delete` in `finally` after completion, failure, or timeout.

See [`docs/extensions/video.md`](../../docs/extensions/video.md) for full configuration and tool reference.

## Validate

```sh
pnpm --filter @eve/video typecheck
pnpm --filter @eve/video build
pnpm --filter @eve/video test:unit
pnpm --filter @eve/video test:integration
```
