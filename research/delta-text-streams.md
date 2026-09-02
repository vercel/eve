---
issue: TBD
status: prototype
last_updated: "2026-09-02"
---

# Delta text streams

## Summary

`message.appended` and `reasoning.appended` currently persist both the latest model delta and the complete text accumulated for that block. Repeating a growing cumulative snapshot makes durable bytes grow quadratically with the generated text, even though `message.completed` and `reasoning.completed` persist the final blocks.

Store only each delta. Consumers that need progressive text accumulate those deltas in stream order; completed events carry the authoritative value for each finalized block.

## Stream contract

```ts
type MessageAppendedData = {
  messageDelta: string;
  // Existing stream coordinates remain unchanged.
};

type ReasoningAppendedData = {
  reasoningDelta: string;
  // Existing stream coordinates remain unchanged.
};
```

Adjacent deltas may be coalesced while a durable write is in flight when their event type, stream coordinates, and tool `callId` match. The resulting text and event ordering stay the same. Completed events carry finalized block values.

This is a stream-version 25 breaking change: `messageDelta` replaces the `messageDelta` plus `messageSoFar` pair, and `reasoningDelta` replaces the `reasoningDelta` plus `reasoningSoFar` pair. Streamed tool input drops `inputTextOffset` and uses the same plain-delta contract.

## Consumer rule

```ts
current += delta;
```

Replay produces the same accumulated state as live delivery when it begins before the relevant deltas.

## Consumer migration

| Consumer                    | Cumulative state                                    | Projection                                                                                                     |
| --------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Default message reducer     | Latest streaming text/reasoning/tool-input part     | Appends deltas and replaces provisional text with the completed event.                                         |
| Chat SDK channel            | In-memory text keyed by channel-state identity      | Posts the first delta, edits with accumulated text, and finalizes from `message.completed`.                    |
| Slack channel               | In-memory reasoning keyed by channel-state identity | Preserves progressive reasoning status and throttling behavior.                                                |
| TUI                         | Text per turn, step, type, and generation           | Emits deltas; a divergent completed event renders as a separate canonical generation.                          |
| Next.js trace viewer        | Text per trace step                                 | Uses the public `MessageStreamEvent` union, so stream schema changes fail its compile rather than its runtime. |
| ACP and subagent pump       | None                                                | Continue forwarding each raw delta; no migration is required.                                                  |
| Authored channels and hooks | Consumer-owned                                      | Append deltas when cumulative text is required, or handle each chunk directly.                                 |
| Published extensions        | Compiled capability contracts                       | Rebuild and republish packages whose manifest uses an epoch advanced by this stream event change.              |

## Retry and reconnect semantics

A provider retry reuses its turn and step coordinates. If the failed attempt emitted partial text, raw delta consumers see that text followed by the successful attempt's deltas because the append protocol does not carry attempt identity. When the failed attempt emitted only deltas, the default reducer and Chat SDK channel replace provisional text when a completed event arrives. The TUI cannot retract text already emitted to its renderer, so it renders a divergent completed event as a separate generation. Completed blocks from an attempt that later fails remain durable; retracting them would require attempt identity.

A consumer that reconnects with both its prior accumulator and stream cursor continues normally. A consumer that retained only the cursor cannot reconstruct earlier text from a later delta; it must replay the earlier events or wait for the completed event. This is the capability removed with cumulative append snapshots. Numeric character positions do not solve that missing-content problem, so the protocol does not carry them.

Supported clients rely on the durable event cursor for ordered delivery. The delta contract does not validate character continuity. A raw consumer that omits an event can produce an incomplete accumulator; numeric positions could detect some such gaps but could not recover the missing text.

The client reads the stream version header on every connection. It normalizes v21–v24 cumulative message and reasoning appends, plus v24 offset-based tool-input appends, into the v25 delta-only contract before reducers see them, including when a reconnect crosses deployments. A current server performs the same normalization when replaying events persisted by an earlier deployment. Missing, unsupported, or shape-inconsistent versions fail instead of being cast to the current event union.

Built-in channel accumulators live in weak maps keyed by in-memory channel-state identity, not as properties of persisted channel state. The runtime serializes `channel.state` at the durable turn-step boundary, so putting cumulative text there would reintroduce an unnecessary snapshot write even though it would not repeat once per append event.

## Validation

- Protocol and emission tests assert plain-delta shapes and coalescing boundaries.
- Default reducer tests cover accumulation and canonical completion after an interrupted attempt.
- Chat SDK, Slack, and TUI regressions cover their cumulative projections and completed-event behavior.
- A reconnect regression starts with a v24 cumulative append and completes the same block from a v25 continuation.
- The Next.js trace aliases the public event union, making stale append-field reads a compile-time error.
- Extension-contract reports identify every capability epoch that extension authors must rebuild.
