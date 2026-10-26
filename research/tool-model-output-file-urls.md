---
issue: https://github.com/vercel/eve/issues/5202
status: proposed
last_updated: "2026-10-22"
---

# Tool model output file URLs

## Summary

`toModelOutput` content file parts accept only base64 `{ type: "data" }`.
A tool working with large files, such as PDFs in object storage, must
download them, base64-encode them, and let eve stage the bytes into the
sandbox and re-read them on every model call. The bundled AI SDK already
accepts `{ type: "url", url }` file data in tool results. This plan
exposes it.

## Authoring API

```ts
toModelOutput(output) {
  return toolOutput.content([
    toolOutputPart.fileUrl(output.signedUrl, { mediaType: "application/pdf" }),
  ]);
}
```

`ToolModelOutputPart` file data widens to
`{ type: "data"; data: string } | { type: "url"; url: string }`. The URL is
a string so the authored shape stays JSON-safe.

## Semantics

- Only `https:` URLs are accepted. This also rejects eve's internal
  attachment schemes (`eve-sandbox:`, `eve-url:`), which the hydrator
  trusts as sandbox reads and must never be authored.
- The harness parses the string into a `URL` when it normalizes the
  output, matching the AI SDK `FileData` shape. History already persists
  `URL` values for staged sandbox refs, so no new durable type is needed.
- URL parts skip sandbox staging and hydration. Compaction stubs them like
  any other file part, and token estimation already counts remote files.
- The AI SDK decides delivery per model: a URL the model supports is sent
  to the provider (Anthropic image or document URL sources, OpenAI
  Responses `file_url`/`image_url`, every URL through AI Gateway); any
  other URL is downloaded by the AI SDK before each call.
- The URL is replayed on every later model call. It must outlive the
  session; an expired presigned URL fails later calls. Providers still
  bill the file's input tokens on each call.

## Out of scope

- `{ type: "reference" }` provider file ids. In tool results, the
  Anthropic adapter drops them with a warning and the Google adapter
  turns them into JSON text, so a model fallback or provider switch would
  silently lose the file. Supporting them needs a loud failure for
  providers that cannot read them.
- `{ type: "text" }` file data.
- Re-signing or re-staging expired URLs.

## Verification

- Unit (`harness/tool-model-output.test.ts`): `fileUrl` parts normalize to
  a `URL`; non-`https:` URLs, including internal schemes, are rejected.
- Unit (`harness/tool-loop.test.ts`): a workflow tool's URL part reaches
  the model call unchanged without a sandbox write.
