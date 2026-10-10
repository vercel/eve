---
issue: https://github.com/vercel/eve/issues/3419
status: proposed
last_updated: "2026-10-10"
---

# Attachments without a new primitive

## Summary

eve's attachment pipeline mostly works, but its rough edges keep breaking
sessions. One file that eve can't resolve or a provider rejects stays in
history, so every later model call fails the same way (#3419, #855, #497, and
earlier #399, #2089, #276). Channels also give `FilePart.data` different
meanings, the inline decision trusts declared media types, and `read_file`
can't reopen a PDF.

This plan keeps today's storage: staged files in the session sandbox, refs in
history. It replaces #4223's pluggable attachment store. It fixes the pipeline
around one rule: **every attachment becomes a staged file or a note before it
enters history**. It adds three small authoring surfaces and no new
definition type.

## Mental model

An attachment is a file in the session. A channel gives eve bytes or a URL.
Inside the workflow step, eve turns it into a file in the sandbox or replaces
it with a note that says why it couldn't. Before each model call, eve shows the
file inline when the model can read it natively, and always names its path.

```text
channel            staging (in step)                  model call
bytes | URL  --->  fetchFile / eve fetch --> sandbox --> label + inline bytes
                          |                  ref         or label only
                          +--> note (text part)
```

"Inline" means the bytes travel in one model request, read back from the
sandbox for that call. History and workflow snapshots hold only the ref: path,
size, media type, and image dimensions or PDF page count.

## Invariants

- History holds only `eve-sandbox:` refs or text notes for attachments. It
  never holds a raw URL, an `eve-url:` marker, or inline bytes. This covers user
  messages, cancelled turns, and tool results. The one exception is an AI SDK
  provider file reference, which names a file the provider already holds and
  passes through unchanged.
- The provider never fetches an attachment. eve fetches it or writes a note,
  so an expired or private link can't fail later calls.
- The inline decision stays a pure function of the ref, so the prompt cache
  holds. It inlines only formats that eve verified from the bytes.
- Every attachment the model sees has a label with its sandbox path.
- Channels don't filter attachments by media type. `uploadPolicy` decides what
  eve accepts, and the inline decision decides inline or label.

## Authoring surface

| Surface                    | Change                                                                                                                                        |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `FilePart.data`            | Bytes, base64, and `data:` URLs are bytes. Any other string or `URL` with a scheme is a link to resolve. A provider reference passes through. |
| `fetchFile(url, ctx)`      | Also on `eveChannel()`. Returning `null` now means "not mine", not "let the provider fetch it".                                               |
| `attachmentError(message)` | New in `eve/channels`. A `fetchFile` throws it to give the model a safe reason.                                                               |
| `FetchFileContext`         | Exposes `session`, which staging already passes. `FetchFileFunction` and its types export from `eve/channels`.                                |
| `read_file`                | Opens PDFs up to 20 MiB as files the model reads.                                                                                             |

When `fetchFile` returns `null`, or the channel has none, eve fetches public
`https:` links itself, at most 10 per message and one at a time. The fetch
rejects private and reserved addresses, stops at the 25 MB default upload cap,
and times out. Any other scheme, or a failed
fetch, becomes a note. Built-in channel fetchers keep their own caps.

```ts title="agent/channels/eve.ts"
import { eveChannel } from "eve/channels/eve";
import { attachmentError } from "eve/channels";

export default eveChannel({
  async fetchFile(url) {
    if (!url.startsWith("https://uploads.example.com/")) return null;
    const response = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}` } });
    if (!response.ok) throw attachmentError(`The upload returned HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
  },
});
```

A web client can then upload a large file to its own storage and send the URL
in a file part. The bytes skip the request body limit and the workflow start
payload, and the step loads them.

## Model-facing rendering

Each attachment renders as a label, followed by its bytes when it inlines:

```text
Attached file /workspace/.eve/attachments/<hash>/chart.png (image/png)
```

| Kind                       | Inlines when                                                           |
| -------------------------- | ---------------------------------------------------------------------- |
| PNG, JPEG, GIF, WebP image | Up to 3 MiB and at most 8000 px per side, by the dimensions on the ref |
| PDF                        | Up to 20 MiB, and the bytes start with a PDF header                    |
| Anything else              | Never; the label is enough for `read_file` or `bash`                   |

Staging corrects the declared media type from the bytes for these formats. A
declared image or PDF whose bytes don't match is staged as
`application/octet-stream`. HEIC, SVG, and TIFF render as labels. Tool-result
files follow the same rule; today they always inline.

The new labels change how existing messages render, so each live session pays
one prompt-cache rewrite on upgrade.

## Channel fixes

- When a mention carries no files, Slack collects the files of every message
  since the previous mention of the app, capped at 10 messages and skipping
  the app's own messages (#705). That earlier mention's turn collected the
  files before it. A message that doesn't mention the app gets no lookback. It skips `mode: "external"` files such
  as Google Drive links, whose link stays in the message text (#855). It stops
  dropping audio and video, and its file fetch gets a timeout.
- Bytes in a `send()` payload cross the queue as `data:` URLs, so no world
  serializer sees a raw `Uint8Array` (#497). `message.received` reports an
  inline file's size instead of echoing its `data:` URL, because the session
  stream stores that event.
- A cancelled turn stages its attachments inside the framework providers, so a
  photo sent just before a steering message survives (#3419).

## Deferred

- **A pluggable store** (#4223). No open issue reports lost files since #325
  turned missing bytes into a `FileNotFound` note. The sandbox boot per
  attachment costs time, not correctness.
- **Inline audio and video for Gemini** (#543). Gemini reads them natively,
  but inline media is re-sent on every model call and counts against a
  per-request size limit. A few clips could exceed it and fail every later
  call, which is the failure this plan removes. Provider file references, such
  as the Gemini Files API, fit this better and need a store. Until then, audio
  and video render as labels, and the agent can process them with tools.
- **Per-request image limits.** Anthropic lowers its per-side limit to 2000 px
  when a request carries more than 20 images. Gating on that would need the
  inline decision to count images across history, which breaks its purity.
- Outbound files, a `toModel` conversion hook, model capability metadata, and
  trace content.

## Rollout

Each step is one PR in a stack, in this order:

1. This plan.
2. Never persist an unresolved attachment: cancelled turns, no-sandbox
   fallbacks, unknown `data` shapes, bytes across the queue, and removal of the
   unused `eve-attachment:` refs.
3. eve fetches unresolved links instead of the provider.
4. Labels on every attachment, media types verified from bytes, and one
   inline rule for inbound and tool-result files.
5. `read_file` opens PDFs.
6. `fetchFile` on `eveChannel()` (#4194).
7. `attachmentError`, `FetchFileContext.session`, and the exported `fetchFile`
   types (#4304).
8. Slack thread lookback, external files, audio and video, and fetch timeout
   (#705, #855).

## Verification

- Unit: `data` normalization, the media type check, the inline rule, labels,
  `read_file` on a PDF, and Slack lookback.
- Integration: staging across a cancelled turn, a link with no resolver, a
  failing fetch, and hydration of old refs.
- Channel conformance: the web chat driver sends files, so the HTTP channel
  joins the attachment rows.
