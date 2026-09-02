---
issue: TBD
status: prototype
last_updated: "2026-09-01"
---

# Offset-addressed text streams

## Summary

`message.appended` and `reasoning.appended` currently persist both the latest model delta and the complete text accumulated for that block. Repeating a growing cumulative snapshot makes durable bytes grow quadratically with the generated text, even though `message.completed` and `reasoning.completed` persist the final blocks.

Store only each delta and its starting offset, matching `action.input.appended`. Reconstruct cumulative text at consumers through one `eve/client` API.

## Stream contract

```ts
type MessageAppendedData = {
  messageDelta: string;
  messageOffset: number;
  // Existing stream coordinates remain unchanged.
};

type ReasoningAppendedData = {
  reasoningDelta: string;
  reasoningOffset: number;
  // Existing stream coordinates remain unchanged.
};
```

Offsets count zero-based UTF-16 code units. Adjacent events may be coalesced while a durable write is in flight; the combined event keeps the first delta's offset. Completed events remain the canonical finalized text.

This is a stream-version 25 breaking change: `messageOffset` replaces `messageSoFar`, and `reasoningOffset` replaces `reasoningSoFar`.

## Client API

```ts
import { appendStreamTextDelta } from "eve/client";

const next = appendStreamTextDelta(current, offset, delta);
```

The helper has three outcomes:

- Offset `0` starts or restarts the current block.
- An offset equal to `current.length` appends the delta.
- A gap or overlap returns `undefined` so consumers do not concatenate corrupt text.

The API is pure: replay produces the same state without hidden accumulator identity or lifecycle.

## Consumer migration

| Consumer                    | Cumulative state                                    | Projection                                                                                                                             |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Default message reducer     | Latest streaming text/reasoning/tool-input part     | Calls `appendStreamTextDelta` before upserting the part.                                                                               |
| Chat SDK channel            | In-memory text keyed by channel-state identity      | Posts the first accepted block, then replaces that post with accumulated text.                                                         |
| Slack channel               | In-memory reasoning keyed by channel-state identity | Preserves progressive reasoning status and throttling behavior.                                                                        |
| TUI                         | Text per turn, step, type, and generation           | Emits accepted suffixes and blocks unsafe deltas after a restart or discontinuity because emitted terminal output cannot be retracted. |
| ACP and subagent pump       | None                                                | Continue forwarding each raw delta; no migration is required.                                                                          |
| Authored channels and hooks | Consumer-owned                                      | Use the helper when cumulative text is required, or handle raw deltas directly.                                                        |

## Retry and reconnect semantics

A durable step retry reuses its turn and step coordinates. Its first offset-`0` event restarts replaceable projections such as the default reducer and channel posts. The TUI cannot retract text already emitted to its renderer, so a restart or discontinuity blocks further deltas for that visible part. A completed event may still extend the visible prefix; otherwise the next step boundary closes the old part without splicing attempts.

A consumer that reconnects with both its prior accumulator and stream cursor continues normally. A consumer that retained only the cursor cannot reconstruct a block from a later nonzero delta; it must replay from the start of that block or wait for its completed event. This is the capability removed with cumulative append snapshots.

Built-in channel accumulators live in weak maps keyed by in-memory channel-state identity, not as properties of persisted channel state. The runtime serializes `channel.state` at the durable turn-step boundary, so putting cumulative text there would reintroduce an unnecessary snapshot write even though it would not repeat once per append event.

## Validation

- Protocol and emission tests assert offsets and coalescing boundaries.
- Shared helper and default reducer tests cover starts, contiguous appends, UTF-16 offsets, gaps, overlaps, and restarts.
- Chat SDK, Slack, and TUI regressions cover their cumulative projections and retry behavior.
- Extension-contract reports identify authored hooks and channels as breaking migration surfaces.
