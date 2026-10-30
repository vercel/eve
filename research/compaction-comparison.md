---
issue: "TBD (follows vercel/ai#24087 and the compaction strategy discussion)"
status: draft
last_updated: "2026-10-30"
---

# Compaction strategies compared: eve, opencode, Codex

eve's compaction API (`compaction.compact`, with `{ compact, when }` triggers) should be able to
express the compaction of other agents, not only eve's own. This note ports opencode's and
openai/codex's compaction to eve strategies and runs all three on one replay.

## The strategies

|               | eve default                             | opencode                                                                           | Codex                                                                                            |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When          | before a model call, over the threshold | before a model call, once input reaches the window less the output reserve         | before a model call at 90% of the window; after a turn only with a post-turn share (default off) |
| Summary input | the head, as eve's transcript           | a text transcript of the head (tool output cut to 2k chars), no system, no tools   | the whole history, under the agent's instructions                                                |
| Kept          | fixed tail of messages                  | newest whole turns within 25% of the usable window (2k to 15k), or a turn's end    | newest user messages within 20k tokens                                                           |
| Summary goes  | first                                   | first, then the tail, then "Continue if you have next steps..."                    | last, after the kept user messages                                                               |
| On overflow   | compacts and retries the call once      | summarizes up to the turn's input, then replays it                                 | drops the oldest item from the summary request until it fits                                     |
| Prune         | none                                    | clears tool output past the newest 40k after each turn, when enabled (default off) | none                                                                                             |

Sources: [`fixture strategies`](../e2e/fixtures/agent-compaction-comparison/strategies/),
ported from opencode v1.19.5 `packages/opencode/src/session/compaction.ts`, `overflow.ts` and
`packages/core/src/session/compaction.ts` (810c0eba), and openai/codex `codex-rs/core/src/compact.rs`
and `session/context_window.rs` (184c9c55). Each port keeps its source's defaults.

## API changes the ports needed

| Change                                                                                             | Needed by |
| -------------------------------------------------------------------------------------------------- | --------- |
| `StoredHistoryMessage`: every user message carries a typed `kind` (`HistoryMessageKind`)           | both      |
| A summary can go anywhere, as a `context.compaction` user message of the strategy's own            | Codex     |
| An automatic result no longer has to keep the turn's latest user message                           | opencode  |
| `ctx.summarize(..., { prompt, system })`: replace the agent's instructions, or send none with `""` | opencode  |
| `measure.maxOutputTokens`, from AI Gateway's model catalog                                         | opencode  |
| `ctx.model`: the session model's window and output limit inside `compact`                          | opencode  |
| A step the provider rejects as too long compacts with `reason: "overflow"` and retries once        | both      |
| `ctx.summarize()` rejects with `CompactionOverflowError` when the summary request is too long      | Codex     |

opencode summarizes the current turn's input when that turn is bigger than its tail budget, then
tells the model to continue; eve's rule that an automatic result keeps the turn's input made that
impossible. Codex's mid-turn compaction ends the history with the summary, which `ctx.checkpoint()`
could not place.

## Method

The [`agent-compaction-comparison`](../e2e/fixtures/agent-compaction-comparison/) fixture declares
a 16k-token window and a 0.6 threshold for eve's default. Its replay is seven turns: six turns each
read one ~3.4k token file with `read-file`, then the last asks for an access code that only the
first file holds. Each strategy runs as its own agent (`EVE_COMPACTION_STRATEGY`) on the same
replay:

```sh
cd e2e/fixtures/agent-compaction-comparison
EVE_E2E_MODEL=mock node replay.mjs     # deterministic
node replay.mjs                         # the default e2e model
```

opencode's and Codex's absolute token constants are sized for ~200k windows, so the fixture scales
them by 16k/200k. A declared window hides the model's output limit, so the opencode agent reserves
opencode's 32k cap, scaled.

A run passes when every compaction completes (the rewritten history passed `checkHistory`) and the
last reply holds the code. `reads` counts `read-file` calls: more than six means the agent lost the
code and read the file again.

## Results

The mock model, for a deterministic baseline:

|                   | default | opencode | Codex   |
| ----------------- | ------- | -------- | ------- |
| Task finished     | yes     | yes      | yes     |
| Compactions       | 2, step | 1, step  | 1, step |
| Model calls       | 13      | 14       | 14      |
| `read-file` calls | 6       | 6        | 6       |
| Input tokens      | 75,523  | 65,865   | 94,027  |

The real model (the e2e default, `e2eModel()`), one run each:

|                   | default | opencode | Codex   |
| ----------------- | ------- | -------- | ------- |
| Task finished     | yes     | yes      | yes     |
| Compactions       | 3, step | 1, step  | 1, step |
| Model calls       | 14      | 14       | 14      |
| `read-file` calls | 6       | 6        | 6       |
| Input tokens      | 77,814  | 91,621   | 103,027 |
| Cache-read tokens | 75,867  | 78,953   | 82,593  |

No strategy lost the code: every run read each file once. Codex no longer thrashes: the earlier port,
which had to put the summary first and also compacted after each turn, compacted 20 times with 74
reads on the same replay. opencode and
Codex compact once and then carry a larger history to the end, so they spend more input tokens than
eve's default, which compacts three times.

Out of scope here: provider-native compaction items (Codex's encrypted `Compaction` item), background
precompute, and cache-TTL timers.
