---
issue: https://github.com/vercel/eve/issues/1842
status: proposed
last_updated: "2026-08-08"
---

# Channel delivery idempotency

## Purpose

Let a channel attach a provider-owned delivery ID to `from(address).send()` so retrying an
at-least-once webhook cannot start the same session turn twice. The guarantee belongs to the
session driver: process-local caches do not survive replicas, restarts, or workflow replay.

This is the idempotency primitive requested by #624. It does not impose FIFO ordering between
different deliveries or replace application-level buffering for bursty channels.

## Authoring API

```ts
await from(address).send(message, {
  auth,
  idempotencyKey: providerDeliveryId,
});
```

The option is additive. An omitted key preserves current delivery behavior. A key is scoped to
the resolved session, so different sessions may use the same provider ID.

## Runtime semantics

1. The initial delivery key seeds the session's durable guard before its first turn runs.
2. Follow-up keys cross the same durable command-inbox boundary as their messages.
3. A repeated retained key returns the owning session without starting or buffering another turn.
4. The guard retains the 1,024 most recently accepted keys in insertion order. Accepting a new key
   evicts the oldest; delivery with an evicted key is accepted again.
5. Unkeyed deliveries are never retained or deduplicated.
6. Workflow replay reconstructs the same guard from the initial input and committed inbox events.

Slack supplies the verified Events API `event_id` for inbound message and generic-event sends.
Custom web channels should use the stable request or delivery identifier from their provider.

## Non-goals

- ordering different keys;
- a global key namespace across sessions;
- deduplicating arbitrary side effects inside an authored webhook handler;
- indefinite retention of every key received by a long-lived session;
- changing `respond()`, control operations, or unkeyed sends.
