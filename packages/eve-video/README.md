# @eve/video

`@eve/video` adds video generation, editing, and extension to an eve agent as a durable background workflow task (`defineWorkflowTool({ task })`) backed by AI SDK and Vercel AI Gateway video models, with webhook-first delivery, durable `sleep()` polling fallback, provider-agnostic storage, sandbox input and output support, and model-facing guidance.

## Install

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

Mounting as `video.ts` adds `video__generate` as a background workflow task and appends model instructions. Default string model IDs route through Vercel AI Gateway (`AI_GATEWAY_API_KEY` or Vercel OIDC), and you can also pass an AI SDK v4 or v3 `VideoModel` instance directly.

## Entry points

- `@eve/video`: default export (`video`) extension factory.
- `@eve/video/tools`: `generate` workflow tool definition (reads `extension.config` lazily and falls back to defaults without a mount).
- `@eve/video/storage`: `localDisk()`, `inMemory()`, and `VideoStorage` types.
- `@eve/video/vercel`: `vercelBlob()` storage adapter and `VercelBlobVideoStorageOptions`.
- `@eve/video/core`: composable primitives (`startVideoJob`, `checkVideoJob`, `persistVideos`, `verifyGatewayWebhookSignature`, `DEFAULT_VIDEO_MODEL`) and TypeScript types.

See [Video Generation](https://eve.dev/docs/extensions/video) ([`docs/extensions/video.md`](../../docs/extensions/video.md)) for configuration, webhooks, video editing and extension, storage auto-selection, approval policies, limits, and the `@eve/video/core` API.

## Validate

```sh
pnpm --filter @eve/video typecheck
pnpm --filter @eve/video build
pnpm --filter @eve/video test:unit
pnpm --filter @eve/video test:integration
```
