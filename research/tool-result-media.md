---
issue: https://github.com/vercel/eve/issues/3833
status: implemented
last_updated: "2026-10-02"
---

# Media in session history: storage, prompt cache, and token estimates

Covers [#3833](https://github.com/vercel/eve/issues/3833) (tool-result media
retained in persisted history) and
[#3799](https://github.com/vercel/eve/issues/3799) (compaction counts image
bytes as text). Supersedes #4016/#4017 (stub at turn settle) and #3802 (stub-size
estimate).

## Summary

Durable session history stores **media refs, never bytes**. Every model call
hydrates every ref **deterministically**, so the provider sees byte-identical
prompts from call to call. Media leaves the model view only during
**compaction**, which already resets the prompt cache. A **media-aware
estimator** replaces `JSON.stringify(...).length / 4` for media, so compaction
fires at the right time.

Together these fix storage, which the refs remove, and keep the prompt cache
intact, since no rewrite happens between compactions. Images stay visible
until compaction, like any other context. Old images can still be reopened.

## What the prompt cache requires

Provider facts that constrain the design:

|                        | Anthropic (direct, Bedrock, Vertex)                                                                                                                                             | OpenAI (Responses)                          | Gemini                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- | ------------------------------- |
| Matching               | Prefix hash at breakpoints. Reads look back ≤ 20 positions for earlier writes.                                                                                                  | Longest matching prefix across breakpoints. | Implicit prefix caching (2.5+). |
| Media in cached prefix | Yes                                                                                                                                                                             | Yes, including `detail`                     | Yes                             |
| Special media rule     | **Adding or removing images anywhere invalidates the messages cache** ([docs](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache)) | —                                           | —                               |
| Pricing                | Write 1.25×, read 0.1×, 5-minute TTL                                                                                                                                            | Discounted reads                            | Discounted reads                |

eve already designs for cache stability. `prompt-cache.ts` adds Anthropic
breakpoints on tools, system, the last message, and the previous assistant
message, and sets `gateway.caching = "auto"`. Announcements and connection
tools are deduped to keep the prefix stable. The rules that follow for media:

1. **Rendering is append-only.** Once a message has been sent, it renders
   byte-identically on later calls: same bytes, `mediaType`, part order,
   filename, and provider options. Hydration must be a pure function of the
   ref, never of turn age, media count, or wall-clock time.
2. **Image presence must not toggle** between calls. On Anthropic, going from
   "some image present" to "no image present", or back, invalidates the whole
   messages cache.
3. **Evict rarely and in batches**, at moments that already reset the cache.
   Anthropic's own tools follow this rule: context editing has `clear_at_least`,
   and the computer-use reference has `min_removal_threshold`.
4. **Hydration failures must not silently change the prompt.** A transient
   store error retries the step. Degrading to text is for media that is gone
   for good, as in #325's stale-snapshot case.

## Why #4016 has the wrong shape

#4016 stubs tool-result files when a turn settles. That rewrites earlier
messages between ordinary calls, which breaks rules 1–3:

- **Anthropic, images in every turn** (the #3833 workload): call 1 of each turn
  has no images because the earlier ones were stubbed, so presence toggles and
  the whole messages cache is rewritten. The tool then returns images, presence
  toggles back, and the cache is rewritten again. Worked example: 50k-token
  history, 16 retained images at 1.5k tokens each, 2 calls per turn, warm
  cache. Keeping images costs about 18k input-token-equivalents per turn.
  #4016 costs about 128k, roughly 7× more. With a cold cache (turns more than
  5 minutes apart) the second rewrite still happens.
- **OpenAI and Gemini**: the divergence starts at the previous turn's first
  image. Only that turn's (now small) tail is re-processed, so token cost is
  about neutral. The model still permanently loses the image.
- **Semantics:** a later turn can't look at an earlier result again (`read_file`
  is text-only). Inbound attachments, which stay hydrated forever, and tool
  media now follow different rules.
- **Coverage:** within-turn persistence is not addressed. Each `turnStep`
  input (`step_created.input`) still carries every byte returned so far in the
  turn. That is O(steps²) for screenshot-loop agents.

The presence-toggle numbers rely on Anthropic's documented rule. Verification
below measures them directly.

## Design

### Invariant

> History that leaves a durable step never contains inline media bytes.
> Media appears as bytes only in the per-call model request.

`hydrateSandboxAttachments` already enforces this for inbound attachments. The
design generalizes it to tool results (authored `toolOutputPart.file`, MCP
`image` / `audio` / `resource.blob` via `connectionToolModelOutput`, and
workflow-tool projections).

### Media refs

```text
tool result ──► handleStepResult / coordination: put(bytes) ──► ref in history
                     (before any provider has seen the part)        │ durable
model call  ◄── hydrate every ref (pure, content-addressed) ◄───────┘
compaction ──► batched eviction: ref ──► "Attached file <path> (<type>)"
```

- **Ref pass.** Runs where new messages enter history: `handleStepResult`
  response messages and coordination tool results. Because tool results reach
  a provider only on the next call, the first provider request already sees
  the hydrated, canonical form, so there is no one-time cache divergence.
- **Ref shape.** Today's `eve-sandbox:` ref, extended with optional
  `width`, `height`, and `pages`. A tool-result file part keeps its filename
  and media type and swaps `data: { type: "data" }` for
  `data: { type: "url", url: <eve-sandbox: ref> }`. Dimensions and page counts
  are parsed once at write time from image headers (PNG, JPEG, GIF, WebP) and
  the PDF page tree, with no dependency. They exist for the estimator.
- **Store contract.** Write bytes to `/workspace/.eve/attachments/<sha>/<name>` and
  read them back by ref path. Content-addressed and immutable. Refs are
  minted only by eve: the HTTP channel already rejects internal ref schemes,
  and `normalizeToolModelOutput` rejects non-`data` file tags. The sandbox is
  the interim backend, the same one inbound attachments use. Its costs: a
  vision tool forces the lazy sandbox to boot, hydration needs a running
  sandbox, and snapshot staleness (#325). **The backend belongs to the
  first-class file work** (see the boundary below).
- **Hydration.** `hydrateSandboxAttachments` descends into `tool-result`
  `content` outputs. It still decides inline-vs-text from the ref alone (size
  and media type) and hydrates **all** refs on every call.

### Eviction only at compaction

Media stays in the model view until compaction. Compaction's existing first
rung, the tool-result cap heuristic, already replaces files in the older region
with stubs in one pass, before any summarization. Its stub now names the
staged sandbox path. The sandbox keeps the bytes, and an image-aware
`read_file` (returning a content image part) lets the agent reopen an evicted
image. Reopening adds a new ref, and content addressing dedupes the bytes.

### Token estimation

Provider usage stays authoritative. The estimate only bridges the gap until
the next usage report (`getInputTokenCount`) and drives compaction's own
rulers (`evaluateThreshold`, `selectRecentWindowSize`, `withResumptionGuard`).
It needs to be within the right order of magnitude, not exact. Provider image
costs vary too much for a constant:

| Provider       | Image tokens                                       | Max per image                      |
| -------------- | -------------------------------------------------- | ---------------------------------- |
| Anthropic      | `⌈w/28⌉·⌈h/28⌉` after downscale                    | 4,784 (Claude 4.7+), 1,568 earlier |
| OpenAI GPT-5.x | `⌈w/32⌉·⌈h/32⌉ × 1.2`; `auto` = `original` on 5.5+ | ~36k (30k patches)                 |
| Gemini 3       | Fixed by `media_resolution`                        | 1,120 default, 2,240 `ultra_high`  |

One estimator in `token-estimate.ts` walks parts structurally:

- **Images:** `⌈w/28⌉·⌈h/28⌉`, capped at 4,784, the largest Anthropic cost
  and above Gemini's 2,240. A 28 px patch overestimates OpenAI's 32 px × 1.2
  slightly. Unknown dimensions count as 4,784. One cap keeps the estimator free
  of model identity; the cost is underestimating very large images on OpenAI's
  `original` detail until the next usage report.
- **PDFs:** pages × 3,000. Unknown page count falls back to the character
  heuristic.
- **Other media and all non-media content:** the existing character heuristic,
  with media payloads removed.

This applies to inline parts and to refs, including inbound sandbox refs,
which today count as a few bytes but hydrate to full images. Every
`estimateTokens` caller shares it. #3799's case becomes about 44k + two page
images (~9.5k on Claude 4.7+), against a measured `204152.25` before.

### Providers that stringify tool-result media

`@ai-sdk/openai` `.chat()` serializes `content` tool outputs with
`JSON.stringify`, so base64 reaches the model as text. That costs about 100k+
tokens per image and the model can't see it. OpenAI-compatible chat providers
(LiteLLM-style gateways, like the one in #3799) likely do the same. eve's own
OpenAI factory uses `.responses()`, and the Anthropic and Google adapters send
native blocks.

For `*.chat` providers, the model-view projection moves tool-result media into
a user message that immediately follows the tool message. The move is
deterministic, so it is cache-stable. Gateway server-side conversion is
unverified and needs a live test.

## Boundary with first-class file support

| This design (harness)                             | First-class files                                                      |
| ------------------------------------------------- | ---------------------------------------------------------------------- |
| No-bytes-in-history invariant and ref pass        | Store backend (sandbox, Blob, world-native), retention, deletion, auth |
| Deterministic hydration and media cache rules     | Public authoring API for files and handles                             |
| Media-aware estimator and media metadata          | Client and channel rendering of files                                  |
| Compaction eviction rung, image-aware `read_file` | Provider Files API uploads (`file_id`) as an optimization              |

The interface between them is the store contract and ref shape above. This
design ships on the sandbox backend and takes the new backend when that work
lands.

## Follow-ups

- A compaction trigger on provider media limits. Anthropic allows 100 or 600
  images per request and rejects any image over 2000 px once a request has more
  than 20 images
  ([vision docs](https://platform.claude.com/docs/en/build-with-claude/vision)).
  Ref metadata already carries the dimensions.
- Per-provider image caps, if the single cap proves too coarse.
- A per-process read cache for hydration, keyed by content hash.
- A development-time guard that history leaving a step has no inline bytes.

## Out of scope

- Gemini `thoughtSignature` retention (#3833). Needs provider confirmation.
- Raw `execute` output in `action.result` events. It is persisted once, not
  per step. Document the pattern of returning a reference from `execute` and
  resolving bytes in `toModelOutput`.
- Accurate audio and video costing.
- Timing-based eviction (evicting only when the cache is already cold). It
  saves tokens but makes visibility depend on timing.

## Verification

- **Unit:**
  - The tool loop writes a tool-result file to the sandbox once, keeps only the
    ref in history, and both later calls (next step, next turn) receive the
    exact file the tool returned.
  - A workflow tool's projected file is staged the same way.
  - The estimator counts images by patches from header or ref metadata, keeps
    path-reference attachments as text, and the #3799 case stays near the
    measured baseline (red on the old estimator).
  - Compaction stubs a staged file with its sandbox path.
  - `*.chat` relocation moves files into a following user message.
  - `read_file` returns PNGs as image parts and rejects images over 3 MiB.
- **E2E:** `agent-tools` `to-model-output-content-parts` drops its
  `real-model` tag. The fixture's mock model decodes the stripe colors from the
  image it receives and fails the turn when the replay turn lacks it, so world
  suites gate on hydration across durable steps. `agent-compaction-regressions`
  accepts the path-named stub.
- **Live cache experiment** (gateway key required; not run): same session shape
  under keep-with-refs and #4016-style stubbing. Record `cacheReadTokens` and
  `cacheWriteTokens` from `TokenUsage`, plus Anthropic cache diagnostics
  (`messages_changed`). Run on Claude, GPT-5.x, and Gemini, directly and
  through the gateway.

## Disposition of open PRs

- **#4016/#4017:** superseded by refs; close.
- **#3801/#3802:** superseded by the media-aware estimator and its regression
  test; close.
