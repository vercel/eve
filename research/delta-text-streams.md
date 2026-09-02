---
issue: TBD
status: prototype
last_updated: "2026-09-01"
---

# Delta text streams

## Summary

`message.appended` and `reasoning.appended` currently persist both the latest model delta and the complete text accumulated for that block. Repeating a growing cumulative snapshot makes durable bytes grow quadratically with the generated text, even though `message.completed` and `reasoning.completed` persist the final blocks.

Store only each delta. Add an explicit block-start marker so consumers can distinguish a continuation from the replacement output of a model retry.

## Stream contract

```ts
type MessageAppendedData = {
  messageDelta: string;
  startsBlock: boolean;
  // Existing stream coordinates remain unchanged.
};

type ReasoningAppendedData = {
  reasoningDelta: string;
  startsBlock: boolean;
  // Existing stream coordinates remain unchanged.
};
```

`startsBlock` is `true` on the first delta of a block and `false` on its continuations. A retry starts a replacement block even when it reuses the same turn and step coordinates. Adjacent continuation events may be coalesced while a durable write is in flight; a block start is an ordering barrier. Completed events remain the canonical finalized text.

This is a stream-version 25 breaking change: `messageDelta` replaces the `messageDelta` plus `messageSoFar` pair, and `reasoningDelta` replaces the `reasoningDelta` plus `reasoningSoFar` pair. `startsBlock` replaces the retry-boundary role previously inferred from a zero offset. Streamed tool input adopts the same marker instead of `inputTextOffset`.

## Consumer rule

```ts
if (event.data.startsBlock) {
  current = delta;
} else if (current !== undefined) {
  current += delta;
}
```

The rule replaces accumulated text at a block start, appends continuations, and ignores a continuation when the consumer never saw its block start. Replay produces the same state without hidden accumulator identity or lifecycle.

## Consumer migration

| Consumer                    | Cumulative state                                    | Projection                                                                                                     |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Default message reducer     | Latest streaming text/reasoning/tool-input part     | Replaces the part at a block start and appends continuations.                                                  |
| Chat SDK channel            | In-memory text keyed by channel-state identity      | Posts the first accepted block, then replaces that post with accumulated text.                                 |
| Slack channel               | In-memory reasoning keyed by channel-state identity | Preserves progressive reasoning status and throttling behavior.                                                |
| TUI                         | Text per turn, step, type, and generation           | Emits accepted suffixes and blocks a replacement block because emitted terminal output cannot be retracted.    |
| Next.js trace viewer        | Text per trace step                                 | Uses the public `MessageStreamEvent` union, so stream schema changes fail its compile rather than its runtime. |
| ACP and subagent pump       | None                                                | Continue forwarding each raw delta; no migration is required.                                                  |
| Authored channels and hooks | Consumer-owned                                      | Apply the block-start rule when cumulative text is required, or handle raw deltas directly.                    |
| Published extensions        | Compiled capability contracts                       | Rebuild and republish packages whose manifest uses an epoch advanced by this stream event change.              |

## Retry and reconnect semantics

A durable step retry reuses its turn and step coordinates. Its first `startsBlock: true` event replaces partial output in projections such as the default reducer and channel posts. The TUI cannot retract text already emitted to its renderer, so a replacement block stops further deltas for that visible part. A completed event may still extend the visible prefix; otherwise the next step boundary closes the old part without splicing attempts.

A consumer that reconnects with both its prior accumulator and stream cursor continues normally. A consumer that retained only the cursor cannot reconstruct a block from a continuation; it must replay from the start of that block or wait for its completed event. This is the capability removed with cumulative append snapshots. Numeric character positions do not solve that missing-content problem, so the protocol does not carry them.

The client reads the stream version header on every connection. It normalizes v21–v24 cumulative message and reasoning appends, plus v24 offset-based tool-input appends, into the v25 block-marker contract before reducers see them, including when a reconnect crosses deployments. A current server performs the same normalization when replaying events persisted by an earlier deployment. Missing, unsupported, or shape-inconsistent versions fail instead of being cast to the current event union.

Built-in channel accumulators live in weak maps keyed by in-memory channel-state identity, not as properties of persisted channel state. The runtime serializes `channel.state` at the durable turn-step boundary, so putting cumulative text there would reintroduce an unnecessary snapshot write even though it would not repeat once per append event.

## Validation

- Protocol and emission tests assert block starts and coalescing boundaries.
- Shared accumulation and default reducer tests cover starts, continuations, missing starts, and replacements.
- Chat SDK, Slack, and TUI regressions cover their cumulative projections and retry behavior.
- A reconnect regression starts with a v24 cumulative append and completes the same block from a v25 continuation.
- The Next.js trace aliases the public event union, making stale append-field reads a compile-time error.
- Extension-contract reports identify every capability epoch that extension authors must rebuild.
