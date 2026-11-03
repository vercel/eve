---
issue: "TBD (follows vercel/ai#24087 and the compaction strategy discussion)"
status: draft
last_updated: "2026-10-30"
---

# Compaction strategies compared: fixed tail, recent turns, recent user messages

eve's compaction API (`compaction.compact`, with `{ compact, when }` triggers) should be able to
express other compaction designs, not only eve's own. This note writes two common designs as eve
strategies and runs all three on one replay:

- **Fixed tail** (`default`): eve's own. Summarizes the head and keeps a fixed tail of messages.
- **Recent turns** (`recent-turns`): summarizes the head as a text transcript and keeps the newest
  whole turns within a token budget, optionally clearing old tool outputs.
- **Recent user messages** (`recent-user-messages`): summarizes the whole history and keeps only the
  newest user messages within a token budget, with the summary last.

## The strategies

|               | fixed tail (eve default)                | recent turns                                                                       | recent user messages                                                                             |
| ------------- | --------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| When          | before a model call, over the threshold | before a model call, once input reaches the window less the output reserve         | before a model call at 90% of the window; after a turn only with a post-turn share (default off) |
| Summary input | the head, as eve's transcript           | a text transcript of the head (tool output cut to 2k chars), no system, no tools   | the whole history, under the agent's instructions                                                |
| Kept          | fixed tail of messages                  | newest whole turns within 25% of the usable window (2k to 15k), or a turn's end    | newest user messages within 20k tokens                                                           |
| Summary goes  | first                                   | first, then the tail, then "Continue if you have next steps..."                    | last, after the kept user messages                                                               |
| On overflow   | compacts and retries the call once      | summarizes up to the turn's input, then replays it                                 | drops the oldest item from the summary request until it fits                                     |
| Prune         | none                                    | clears tool output past the newest 40k after each turn, when enabled (default off) | none                                                                                             |

Sources: the [fixture strategies](../e2e/fixtures/agent-compaction-comparison/strategies/).

## API changes the strategies needed

| Change                                                                                             | Needed by            |
| -------------------------------------------------------------------------------------------------- | -------------------- |
| `StoredHistoryMessage`: every user message carries a typed `kind` (`HistoryMessageKind`)           | both                 |
| A summary can go anywhere, as a `context.compaction` user message of the strategy's own            | recent user messages |
| An automatic result no longer has to keep the turn's latest user message                           | recent turns         |
| `ctx.summarize(..., { prompt, system })`: replace the agent's instructions, or send none with `""` | recent turns         |
| `measure.maxOutputTokens`, from AI Gateway's model catalog                                         | recent turns         |
| `ctx.model`: the session model's window and output limit inside `compact`                          | recent turns         |
| A step the provider rejects as too long compacts with `reason: "overflow"` and retries once        | both                 |
| `ctx.summarize()` rejects with `CompactionOverflowError` when the summary request is too long      | recent user messages |

Recent turns summarizes the current turn's input when that turn is bigger than its tail budget, then
tells the model to continue; eve's rule that an automatic result keeps the turn's input made that
impossible. Recent user messages ends the history with the summary, which `ctx.checkpoint()`
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

The two new strategies' absolute token constants are sized for ~200k windows, so the fixture scales
them by 16k/200k. A declared window hides the model's output limit, so the recent-turns agent
reserves its 32k output cap, scaled.

A run passes when every compaction completes (the rewritten history passed `checkHistory`) and the
last reply holds the code. `reads` counts `read-file` calls: more than six means the agent lost the
code and read the file again.

## Results

The mock model, for a deterministic baseline:

|                   | fixed tail | recent turns | recent user messages |
| ----------------- | ---------- | ------------ | -------------------- |
| Task finished     | yes        | yes          | yes                  |
| Compactions       | 2, step    | 1, step      | 1, step              |
| Model calls       | 13         | 14           | 14                   |
| `read-file` calls | 6          | 6            | 6                    |
| Input tokens      | 75,523     | 65,865       | 94,027               |

The real model (the e2e default, `e2eModel()`), one run each:

|                   | fixed tail | recent turns | recent user messages |
| ----------------- | ---------- | ------------ | -------------------- |
| Task finished     | yes        | yes          | yes                  |
| Compactions       | 3, step    | 1, step      | 1, step              |
| Model calls       | 14         | 14           | 14                   |
| `read-file` calls | 6          | 6            | 6                    |
| Input tokens      | 77,814     | 91,621       | 103,027              |
| Cache-read tokens | 75,867     | 78,953       | 82,593               |

No strategy lost the code: every run read each file once. Recent user messages no longer thrashes:
an earlier version, which had to put the summary first and also compacted after each turn, compacted
20 times with 74 reads on the same replay. Recent turns and recent user messages compact once and
then carry a larger history to the end, so they spend more input tokens than the fixed tail, which
compacts three times.

Out of scope here: provider-native compaction items (encrypted compaction items), background
precompute, and cache-TTL timers.
