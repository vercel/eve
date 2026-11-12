---
issue: "https://github.com/vercel/eve/issues/5920"
status: proposed
last_updated: "2026-11-12"
---

# Compaction that reuses the turn's request

## Problem

Every compaction on `main` is a standalone text-summary request:
`summaryExecutor` and `streamCompactionSummary`
(`packages/eve/src/harness/compaction/step.ts`) send `COMPACTION_SYSTEM_PROMPT`
and one `context.compaction` user message holding a transcript, with no tools.
That request shares no prefix with the turn, so it reads none of the prompt
cache the turn just wrote, although it is the session's largest request: it runs
at the threshold, close to the full window. The issue measured 8,255 of 8,304
input tokens read from cache when the turn's system prompt, tools, and messages
were repeated ahead of the summarize message, against 0 for the standalone
request.

It also leaves out OpenAI's native compaction: the Responses API (or a turn
request with a compaction trigger appended) returns an encrypted `compaction`
item that the next turn reads, and that keeps detail a text summary
paraphrases.

## Relationship to #5661

Draft PR #5661 (compaction strategies) is the seam for this work and should land
first:

- It already hands `historyBeforeCall` the turn's request (`request: {
  instructions, tools }`) from `ModelCaller.compact`.
- Its `ctx.summarize(messages, { prompt, reusePrefix })` sends the turn's
  instructions and tools followed by the history and one appended prompt, which
  is the cache-reusing request this issue asks for, available to authored
  strategies.
- It rewrites `compaction/step.ts` and `model-call/call.ts` extensively, so a
  parallel change to the default summary request on `main` would conflict with
  it line for line.

This plan therefore describes what to add on top of #5661 rather than
duplicating its request plumbing.

## Proposal

### 1. Keep the turn's cache keys in a prefix-reusing summary

A cache read only happens when everything the provider keys its cache on
matches the turn byte for byte:

- **Tools head the cached prefix.** Send the step's tool definitions exactly as
  the step sent them (same order, descriptions, schemas, and `strict` flags),
  not a re-derived set.
- **Anthropic keys its message cache on `tool_choice`, thinking, and effort
  settings** ([what invalidates the cache](https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache)). #5661's `streamCompactionSummary` sets `toolChoice:
  "none"` whenever tools are sent, which keeps the tools/system cache but
  invalidates the message cache, the bulk of the request. The summary request
  must keep the turn's tool choice, reasoning settings, and provider options.
  Because the model can then call a tool, the summarize message tells it not
  to, and a response with a tool call (or no text) is treated as a failed
  summary and falls back to the transcript request.
- **Messages:** the turn's framed request messages (what `ModelCaller` sends,
  including memory recall, `context.state`, and client context), followed by
  one summarize message.
- **Cache breakpoints.** The turn's breakpoints come from `prepareStep`
  (`step-hooks.ts`), not from the messages: `applyConversationCacheControl` for
  models with eve's own breakpoints, and Gateway `caching: "auto"` otherwise.
  The summary call never runs `prepareStep`; on `main` and in #5661 it only gets
  `resolveCallProviderOptions`. Anthropic reads the cache only at a breakpoint,
  so the summary request must carry the same breakpoints and Gateway caching
  options the turn's `prepareStep` would set, with the last breakpoint on or
  after the turn's last message.

The summary model must be the turn's model. With `compaction.model` set to a
different model, there is no shared cache and eve keeps today's transcript
request.

### 2. Use it for eve's default compaction

eve's fixed-tail compaction keeps a recent tail verbatim when it can, but its
summary covers the whole conversation, tail included: the later stages can drop
the tail's tool results (`text-tail`) or the whole tail (`summary-only`), and
they never summarize again (`compaction/engine.ts`). The prefix-reusing request
keeps that contract. The summarize message asks for the same summary
`COMPACTION_SYSTEM_PROMPT` asks for today, over everything the model has read,
so each tail stage still finds what it drops in the summary. eve keeps the
transcript request as the fallback when:

- the turn's request plus the summarize message would not fit the model's
  window (for example, a compaction forced by a context-overflow error);
- the summary model is not the turn's model;
- the response is empty or calls a tool.

### 3. Native OpenAI Responses compaction, as a strategy

Native compaction fits #5661's strategy model, with capabilities the strategy
API does not have yet:

- **A provider part that history keeps.** The returned window holds an
  `openai.compaction` item that must be stored and replayed verbatim. eve's
  history validation and `checkHistory` need to accept it, and the summarizer
  transcript must skip it.
- **Pinning the next requests to the issuer.** Only the upstream that minted
  the encrypted item can read it; through AI Gateway an item from OpenAI is
  unreadable on Azure, and Azure drops it silently. While history holds an item,
  `prepareStep` pins routing to its issuer (`providerOptions.gateway.only`),
  keeping the authored `order` and `models` and never widening an authored
  `only`.
- **A text checkpoint for requests that can't read the item.** After a native
  compaction the encrypted item is the only record of the compacted head, and a
  later text summary can't recover it. A step whose model changes (#6186), or
  whose routing no longer allows the issuer, would otherwise run with no memory
  of that head. eve stores a text checkpoint made at the same boundary (the
  prefix-reusing summary from section 1, which reads the same cache) beside the
  item. A request pinned to the issuer replays the item; any other request
  replays the checkpoint in its place, and the next compaction drops the item
  and keeps the checkpoint.

Behavior:

- Tried first when the turn's model is an OpenAI Responses model (direct, or
  `openai/*` through AI Gateway): `POST /responses/compact` with the step's
  request, or the turn's `/responses` request with `compactionTrigger` when the
  backend has no compact endpoint (it returns 404).
- The returned window replaces the history, keeping only the history's own user
  messages: the endpoint echoes every user message it was sent, including
  per-request memory recall, `context.state`, and client context, which eve adds
  again on every request.
- Any failure, missing credential, or content eve can't replay falls through to
  the summary. A native attempt never fails a turn.
- eve logs one outcome per compaction: replaced, failed (with the reason), or not
  attempted (with the reason).

## Tests to add with the implementation

- The summary request's tools, tool choice, provider options, cache
  breakpoints, Gateway caching options, and leading messages equal the turn
  request's, and only one message is appended.
- A summary response with a tool call falls back to the transcript request.
- A summary that falls through to `text-tail` or `summary-only` still covers
  the dropped tail.
- A native window replaces the history, keeps only the history's own user
  messages, and the next request is pinned to the issuer.
- A request that can't be pinned to the issuer replays the text checkpoint, not
  the item.
- A failed or unsupported native attempt falls back to the summary.
