---
issue: https://github.com/vercel/eve/issues/456
status: proposed
last_updated: "2026-07-27"
---

# Tool model output content parts

## Summary

Authored tools can shape what the model sees with `toModelOutput`, but the
eve-owned `ToolModelOutput` union only admits `text` and `json`. A tool that
produces an image — a Playwright screenshot, a rendered chart — cannot hand
the pixels to a vision-capable model; it can only describe them. The AI SDK's
`ToolResultOutput` already supports a `content` variant carrying text and
file parts, and eve already forwards `ToolModelOutput` into that type
unchanged, so the gap is eve's narrower public union and its validation.

Add a `content` variant to `ToolModelOutput` whose file parts carry
JSON-safe base64 strings. The `execute` return stays JSON-only and continues
to feed `action.result` unchanged; only the model-facing projection widens.

## Authoring API

Extend `ToolModelOutput` in `packages/eve/src/shared/tool-definition.ts`:

```ts
export type ToolModelOutput =
  | { readonly type: "text"; readonly value: string }
  | { readonly type: "json"; readonly value: unknown }
  | { readonly type: "content"; readonly value: readonly ToolModelOutputPart[] };

export type ToolModelOutputPart =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "file";
      /** Tagged file data; v1 admits only JSON-safe base64 payloads. */
      readonly data: { readonly type: "data"; readonly data: string };
      /** IANA media type, e.g. `image/png`. */
      readonly mediaType: string;
      readonly filename?: string;
    };
```

Builders ship alongside the union under two namespaces exported from
`eve/tools` (`packages/eve/src/public/tools/index.ts`): `toolOutput` for the
output union and `toolOutputPart` for content parts, so authors never
hand-write the tagged `data: { type: "data", data }` nesting:

```ts
export const toolOutput = {
  text(value: string): ToolModelOutput,
  json(value: unknown): ToolModelOutput,
  content(value: readonly ToolModelOutputPart[]): ToolModelOutput,
};

export const toolOutputPart = {
  text(text: string): ToolModelOutputPart,
  file(base64: string, options: { mediaType: string; filename?: string }): ToolModelOutputPart,
};
```

The builders are pure sugar: each returns the corresponding literal, the
union stays the source of truth, and hand-written literals remain valid.

Authored usage:

```ts
import { defineTool, toolOutput, toolOutputPart } from "eve/tools";

export default defineTool({
  description: "Capture a screenshot of the current page",
  inputSchema: z.object({ url: z.string() }),
  async execute(input) {
    const png = await captureScreenshot(input.url);
    return { path: png.path, screenshotBase64: png.base64 };
  },
  toModelOutput(output) {
    return toolOutput.content([
      toolOutputPart.text(`Screenshot of ${output.path}:`),
      toolOutputPart.file(output.screenshotBase64, { mediaType: "image/png" }),
    ]);
  },
});
```

The shape mirrors the AI SDK's `ToolResultOutput` content parts, narrowed to
the JSON-safe subset: file `data` is the SDK's tagged `FileData` union
restricted to `{ type: "data" }` with a base64 string. This keeps
`ToolModelOutput`'s existing design contract — structurally compatible with
the SDK so the harness forwards it without conversion — and leaves the tag
space open to admit `{ type: "url" }` and `{ type: "reference" }` later
without reshaping the authored API. `defineDynamic` tools and MCP-facing
definitions inherit the change through the shared type; no other authoring
surface moves.

## Semantics

### Where validation happens

`normalizeToolModelOutput` in `packages/eve/src/harness/tools.ts` is the
single funnel for authored `toModelOutput` results. It gains a `content`
case that:

- requires `value` to be a non-empty array;
- for `text` parts, requires a string `text`;
- for `file` parts, requires a non-empty string `mediaType` and a
  `data` object tagged `{ type: "data" }` whose payload is a string;
- rejects `Uint8Array`, `ArrayBuffer`, and `Buffer` payloads — which the
  SDK's `FileData` would otherwise accept — with a
  `ToolOutputSerializationError` that says to base64-encode. Raw bytes would
  not fail loudly on their own — `JSON.stringify` silently corrupts a
  `Uint8Array` into an index-keyed object at the durable boundary, the same
  failure class as issue #497 — so the explicit rejection is the guardrail;
- rejects the `url`, `reference`, and `text` `FileData` tags as
  not-yet-supported, and rejects any other part type.

Valid parts are already in the AI SDK shape, so the existing forwarding
path needs no other change.

### Durability and replay

The AI SDK invokes `toModelOutput` once, while building the step's response
messages; the result is baked into the persisted `tool-result` part. Because
the accepted payload is a base64 string, the part is JSON-safe and survives
the durable stream and workflow worlds verbatim — subsequent steps and
resumed turns replay it without re-invoking the tool or the projection.

Observable consequence: unlike sandbox-ref attachments (hydrated per model
call, ref-only in history), a content-part image lives in history and is
re-sent on every subsequent model call in the session. Documentation should
steer authors toward small payloads; the attachment pipeline's 3 MiB inline
image cap is the reference point. v1 adds a warn log above that size rather
than a hard cap.

### What does not change

- `execute` results must still be JSON-serializable; `wrapToolExecute` and
  its `parseJsonValue` gate are untouched.
- `action.result` still receives the raw `execute` output. Channel handlers
  and hooks never see the projection. The message-part fallback in
  `action-result-helpers.ts` already tolerates a `content` output.
- Tools without `toModelOutput`, and existing `text`/`json` projections,
  behave exactly as before.
- Model compatibility is the author's concern in v1: sending image parts to
  a non-vision model surfaces the provider's error, the same as user-message
  image parts today.

## Boundaries and surfaces

- `packages/eve/src/shared/tool-definition.ts` — union + part type + docs.
- `packages/eve/src/public/tools/output-builders.ts` — `toolOutput` and `toolOutputPart` builders, exported from `eve/tools`.
- `packages/eve/src/harness/tools.ts` — `ToolModelOutputValue` widening and
  the `content` normalization case.
- `docs/tools/overview.mdx` — extend the `toModelOutput` section with the
  `content` variant and payload-size guidance.
- Changeset: `patch` (additive public API).

## Out of scope

- `{ type: "url" }`, provider `reference`, and sandbox-ref file data. The
  sandbox-ref request from the issue thread (image-aware `read_file` /
  `view_image`) is a natural follow-up but needs the hydration pass to
  descend into tool-result outputs, which it does not today.
- `execute` returning content parts directly; the projection boundary stays
  `toModelOutput`.
- Video/audio degradation policy (issue #543) and model-capability
  filtering.
- Compaction-aware trimming of persisted content parts.
- The user-message file-part corruption under `@workflow/world-postgres`
  (issue #497) — same failure class, different boundary; tracked separately.

## Verification

- Unit (`packages/eve/src/harness/tools.test.ts`): content normalization
  happy path (text + file), byte-payload rejection, rejection of `url` /
  `reference` / `text` `FileData` tags, empty-array rejection, unknown-part
  rejection, error identity (`ToolOutputSerializationError`, `toModelOutput`
  boundary); `toolOutputPart.text` / `toolOutputPart.file` produce parts the
  normalizer accepts.
- E2E (`e2e/fixtures/agent-tools/evals/`): a tool returns a 1×1 red-pixel
  PNG via `toModelOutput` content parts; the eval asserts the model names
  the color, proving the bytes reached the model as vision input end to end.
- Docs: `pnpm docs:check` after the overview edit.
