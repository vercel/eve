---
issue: null
status: experimental
last_updated: 2026-10-30
---

# Experimental shared conversation history

`WORKFLOW_SHARED_HISTORY=1` enables the eve preview adapter. Both the SDK and
adapter must contain this protocol; setting the variable on an older deployment
does not activate it. Reads of persisted records remain supported without the flag.

The physical append-only structure is the run's existing ordered DynamoDB event
log. A `hook_received` stores a typed source record once. A `step_completed`
stores a typed, disjoint `[start,end)` conversation segment with assistant/tool
additions and explicit projections of user content from its hook source. Each
step input contains `{logId,end}` for history and ordinary remaining arguments.
It contains neither the history array nor a predecessor-input reference. The
usual event commit publishes the segment, so this protocol introduces no
separate history-publication transaction or uncommitted history head.

The SDK serializes typed records as `SharedHistoryV1` devalue values, compresses
and encrypts them as usual. The server keeps them opaque. It cannot infer Eve
semantics or split an encrypted payload into messages. The server's existing
ordered event Query is also the history range read; this is not a new table or
an independent materialized conversation row. Retry reads skip step inputs,
select committed hook/output segments, and construct the requested immutable
prefix. They do not execute Workflow or step code and do not follow input links.
Cold recovery currently scans all committed producer events and selects the logical prefix in the SDK; its DynamoDB read is not bounded by the conversation cursor yet. A Query may require multiple pages. Large source/output records retain existing
RemoteRef S3 spillover and parallel hydration. The new server span attribute
`workflow.shared_history.protocol=v1` identifies traffic, not authorization.

During ordinary execution, replay already applies Eve's output deltas. Input
serialization adopts that exact history array into an invocation-scoped cache;
the inline step uses its immutable view without another fetch or fold. Prefixes
and their JSON entries are frozen so step code cannot mutate replay's base.
The current adapter supports append-only JSON model messages in a sequential
session. Compaction, nonempty initial history, handoff across runs, arbitrary
branch merges and old-message edits require an explicit new view protocol and
are outside this preview. They must not silently produce an invalid cursor.
Other step state/configuration is still persisted normally and may exceed an
inline cutoff. No Dynamo-only or latency improvement is implied by the flag.

Benchmark TTFC is message POST entry to the first model request issued. Model
response time is excluded. Compare identical prompts/model and preserve raw
samples, storage counters, retry attempts and per-phase measurements.

The benchmark server gives opted-in step-completed records a 64,000-byte inline budget (ordinary outputs keep 8,000 bytes). The comparison therefore measures both the shared encoding and its DynamoDB segment policy. Records above that size retain S3 spillover; this is not a Dynamo-only guarantee.
