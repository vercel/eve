---
issue: https://github.com/vercel/eve/issues/3833
status: proposed
last_updated: "2026-10-02"
---

# First-class attachments

## Summary

Files reach an agent from channels (a Slack image, a PDF uploaded in web chat),
from tools (a screenshot returned through `toolOutputPart.file`), and from the
sandbox (a report the agent downloaded with `curl`). Today the session sandbox
is the only place eve keeps attachment bytes, and that causes most of the file
problems users report:

- Attachments vanish when a deployment-bound sandbox snapshot changes
  (`FileNotFound` on hydration), and the Slack docs tell users to keep files
  elsewhere if they need them later.
- A vision-only Slack turn opens a sandbox just to show the model one image.
- Tool-result images stay inline in session history, so every persisted state
  copy rewrites them (#3833, #3799).
- Without a staged copy, channel URLs reach the provider and fail with
  `AI_DownloadError` on every later turn (#855, #3419).
- Built-in `read_file` returns text only, so an agent that has a PDF or image
  path cannot actually look at it. Customers write their own tools for this.
- Agents cannot send a file they produced back to the user. Internal agents
  maintain four hand-rolled copies of Slack's upload flow.

This proposal adds `eve/attachments`: a pluggable, durable attachment store
modeled on the file-memory backend seam. Every attachment's bytes go into the
store once. Session history keeps only compact refs. Each model call resolves
refs through one model-facing policy. The sandbox receives a copy on demand
and is no longer the source of truth.

eve does no document processing. PDFs and images go to the provider natively.
A single `toModel` hook lets authors replace what the model sees for an
attachment, for example by converting a PDF to Markdown with a third-party
parser.

## Public API at a glance

| Import path              | Public surface                                                         |
| ------------------------ | ---------------------------------------------------------------------- |
| `eve/attachments`        | `defineAttachments`, `inMemory`, `AttachmentStore`, `Attachment` types |
| `eve/attachments/vercel` | `vercelBlob`                                                           |

```ts title="agent/attachments.ts"
import { defineAttachments } from "eve/attachments";
import { vercelBlob } from "eve/attachments/vercel";

export default defineAttachments({
  store: vercelBlob(),
});
```

`agent/attachments.ts` is optional. Without it, eve selects the default store
described in [Store selection](#store-selection). Subagents use the parent
agent's store; attachments themselves are scoped per session.

## Store contract

```ts
interface AttachmentStore {
  /** Idempotent: writing the same key twice with the same bytes succeeds. */
  put(input: {
    readonly key: string;
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly signal: AbortSignal;
  }): Promise<void>;
  get(input: { readonly key: string; readonly signal: AbortSignal }): Promise<Uint8Array | null>;
}
```

Keys are `<sessionId>/<sha256>` for originals and `<sessionId>/<sha256>/model`
for `toModel` output. Content addressing makes workflow-step replays
idempotent and dedupes the same upstream file across turns. Scoping by session
means an attachment ref can only resolve inside the session that holds it.
Backends may prepend their own prefix (`vercelBlob` defaults to
`eve/attachments`).

eve sets no retention policy and deletes nothing. Most blob stores do not
support per-object TTLs, so lifecycle rules belong to the store's owner.

### Store selection

Selection follows file memory. It fails closed and does not fall back to the
sandbox:

| Environment                       | Store                                 |
| --------------------------------- | ------------------------------------- |
| `agent/attachments.ts` present    | The authored store                    |
| Vercel with Blob credentials      | Private Vercel Blob                   |
| Vercel without Blob configuration | None: attachments unavailable (below) |
| `eve dev`                         | Shared process-local `inMemory()`     |
| Every other environment           | None: attachments unavailable (below) |

On Vercel the default reads `EVE_ATTACHMENTS_BLOB_*` first, then generic
`BLOB_*`, using the same token and OIDC rules as file memory. An
`attachments` registry item and `eve integration setup attachments` provision
a private store with the `EVE_ATTACHMENTS_` prefix, reusing the file-memory
setup runner.

When no store is available:

- Inbound channel attachments are replaced with a model-visible note
  ("Attachment `report.pdf` was not stored because this agent has no
  attachment store"), and the turn continues. The operator log names the fix:
  add `agent/attachments.ts` or run `eve integration setup attachments`.
- Tool-result file parts stay inline for the rest of the turn that produced
  them, then are stubbed when the turn completes (#3833 option 2), so vision
  tools keep working within a turn.
- `eve build` and `eve dev` warn when a channel accepts uploads but no store
  can resolve in the target environment.

## Refs in history

A stored attachment appears in history as a `FilePart` whose `data` is a ref:

```text
eve-attachment:?v=2&id=<sha256>&type=<mediaType>&size=<bytes>&name=<filename>&m=<text|file>
```

`m` is present only when `toModel` produced output. Refs are minted only by eve.
The existing channel-boundary check (`hasInternalRefScheme`) keeps rejecting
caller-supplied internal schemes. This replaces the unused v1 `AttachmentRef`
params format and the `eve-sandbox:` scheme. `eve-sandbox:` refs already in
history render as the existing text stub; there is no other migration path.

## Ingestion

Attachments enter the store inside a workflow step. Bytes never cross the
queue or the workflow start payload:

1. **Channel inbound.** `fetchFile` keeps its current contract. Staging writes
   the resolved bytes to the store instead of the sandbox and does not open a
   sandbox. `eveChannel()` gains `fetchFile` (#4194), so web clients can upload
   to their own storage and send a URL.
2. **Tool results.** When a tool result commits, file parts in its
   `toModelOutput` content are moved into the store and replaced with refs.
   Authors keep using `toolOutputPart.file`.
3. **Sandbox files.** `read_file` on an image or PDF stores the file and
   returns it as a file part (see [Model-facing tools](#model-facing-tools)).
4. **Programmatic.** Tool and channel contexts expose
   `attachments.put({ bytes, mediaType, filename })`, which returns an
   `Attachment`, and `attachments.read(attachment)`.

Upload policy (`uploadPolicy`) is unchanged and still runs before ingestion.

## The `toModel` hook

```ts title="agent/attachments.ts"
import { defineAttachments } from "eve/attachments";
import { vercelBlob } from "eve/attachments/vercel";
import { pdfToMarkdown } from "../lib/pdf";

export default defineAttachments({
  store: vercelBlob(),
  async toModel(attachment) {
    if (attachment.mediaType !== "application/pdf") return;
    return { type: "text", text: await pdfToMarkdown(await attachment.bytes()) };
  },
});
```

`toModel(attachment, ctx)` runs once, when a channel or sandbox attachment
enters the store. It does not run for tool results, because tools already
control their model output through `toModelOutput`.

| Return                               | The model sees                                      |
| ------------------------------------ | --------------------------------------------------- |
| `undefined`                          | The original, under the native policy               |
| `{ type: "text", text }`             | The text, in place of the file                      |
| `{ type: "file", bytes, mediaType }` | The replacement file (for example, a smaller image) |

eve stores the output at `<sessionId>/<sha256>/model` and records `m` on the
ref. The output is computed once per attachment and does not depend on the
model. The original stays in the store for `read_file`, the sandbox copy, and
outbound delivery. Text output is also copied to the sandbox next to the
original as `<name>.md`, so the agent can search it with sandbox tools.

If `toModel` throws, eve logs the error and falls back to the native policy for
that attachment. The turn continues.

## Model-facing policy

Hydration replaces refs with model input for each call. It never writes back
to history.

- **Images** up to 3 MB and **PDFs** up to 20 MB inline as bytes, as today.
- **Text** (`text/*`, JSON, YAML, CSV) up to 64 KB inlines as a text part.
- **Video and audio** inline only for model families that accept them; other
  families get a stub (#543).
- **`toModel` text** inlines up to the text budget. Anything beyond it is
  truncated, with a note pointing at the `.md` copy.
- **Budget.** Inline media is capped per call. Attachments fill it newest
  first; older ones become stubs.
- **Stub.** `Attached file report.pdf (application/pdf, 2.1 MB) at
/workspace/attachments/<sha>/report.pdf. Open it with read_file to view it.`
- **Token estimate.** File parts count at a fixed per-image cost, not their
  base64 length (#3799, #3802).

## Model-facing tools

The attachment path is the model's single handle for a file.

- `read_file` handles media. For image or PDF paths it returns a `content`
  output with a file part, which ingestion moves into the store. Paths under
  `/workspace/attachments` are read from the store when the sandbox does not
  have them. Files over the inline limits return an error that suggests
  sandbox tools.
- When eve opens a session sandbox, it writes any session attachments that are
  missing from `/workspace/attachments`, so `bash`, Python, and other tools see
  the same paths.

## Sending files to users

- An `attach_file({ path })` tool is available when the active channel supports
  outbound files. It stores the file and adds it to the assistant reply.
- Channel `message.completed` payloads include
  `attachments: readonly Attachment[]`. Each one exposes `name`, `mediaType`,
  `size`, and `bytes()`.
- The Slack default renderer uploads reply attachments in the thread with the
  reply, deduped per thread by sha, which requires `files:write`. Teams and
  Telegram follow the same pattern.
- Web clients receive file parts with a download URL served by
  `GET /eve/v1/sessions/:id/attachments/:sha`. The route authorizes the caller
  against that session before reading the store.

## Slack

- **Lookback.** Collect files across a bounded window of recent thread
  messages, including bot-authored roots (#705, #706).
- **Remote files.** Skip `mode: "external"` files such as Google Drive or
  Dropbox links (#855, #856).
- **Push vs. pull.** Files on the triggering message are pushed into the turn.
  Earlier thread files are listed as pending refs (metadata and channel URL,
  no bytes). They are fetched through `fetchFile` and stored only when the
  model opens one.

## Design invariants

- History never holds attachment bytes once a store is available.
- Ingestion is idempotent per step replay (the key is content-addressed).
- An attachment ref resolves only within its own session's key prefix.
- eve does not parse, convert, or resize files. `toModel` is the only
  transformation point.
- Channel credentials stay inside `fetchFile` closures and are never written
  to refs or the store.

## Non-goals

- PDF, Office, or image processing inside eve.
- Retention, TTLs, or deletion.
- Provider URL passthrough with signed store URLs (deferred).
- Sharing attachments across sessions. Passing files to subagents and remote
  agents (by copying into the child session's prefix) is a follow-up.
- Browser direct-upload routes. These need an opaque, server-validated upload
  id, because client-supplied refs are rejected. Follow-up.

## Rollout

1. **Fixes with no new API.** #706, #856, #3802, `fetchFile` on `eveChannel`
   (#4194), media-aware `read_file`, inline small text files, and stubbing
   tool-result media in completed turns.
2. **Store and refs.** `eve/attachments`, `inMemory`, `vercelBlob`, store
   selection, v2 refs, ingestion, hydration from the store, sandbox copies on
   open, the setup integration, and docs.
3. **Model-facing policy.** `toModel`, the per-call budget, model-aware
   video and audio, and Slack pending refs.
4. **Outbound.** `attach_file`, `message.completed` attachments, channel
   renderers, and the web download route.

## Verification

- Unit: ref codec, store selection probes, hydration policy and budget,
  `toModel` result handling.
- Integration: staging and hydration against `inMemory()` across simulated
  step boundaries, including a missing sandbox and a replayed step.
- E2E (mock model): an HTTP-channel eval that sends an image and a PDF,
  asserts the model input contains file parts, and asserts persisted history
  contains only `eve-attachment:` refs. A second eval covers `read_file` on a
  sandbox image.

## Primary references

- `packages/eve/src/harness/attachment-staging.ts`
- `packages/eve/src/internal/attachments/`
- `packages/eve/src/public/channels/slack/attachments.ts`
- `packages/eve/src/public/memory/file/backend.ts`,
  `packages/eve/src/public/memory/file/backends/default.ts`
- `research/tool-model-output-content-parts.md`
- Issues #543, #705, #855, #3419, #3799, #3833, #4194
