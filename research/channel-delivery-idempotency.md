---
issue: https://github.com/vercel/eve/issues/1842
status: implemented
last_updated: "2026-10-20"
---

# Channel delivery idempotency

Channels can supply an optional `idempotencyKey` to `from(address).send()` or
`respond()`, and fixed `Session.send()` or `respond()`. The Chat SDK bridge
forwards the same option. Photon uses its native message ID.

```ts
await from(conversationId).send(message, { auth, idempotencyKey: providerEventId });
```

The channel verifies the event and selects its stable ID. The session owner
deduplicates deliveries before routing, coalescing, or executing input. A known
duplicate does not interrupt generation. This is delivery identity, not a
turn ID or a guarantee of exactly-once external side effects.

Keys are nonempty strings of at most 256 characters. Each logical session
remembers the last 1024 distinct keys in admission order; retries do not refresh
retention. The same key can be used in another session. Aliases share the window,
and owner handoffs preserve it. Reset, expiration, or replacement starts a new
window. Reusing a retained key with different input ignores that input: the first
admitted delivery wins. Unkeyed sends retain their existing behavior.

Initial input records its key in the workflow's creation arguments. Losing
creation candidates forward their keyed command to the winner. Keyed creation
waits up to 30 seconds for the canonical session identity; after an ambiguous
failure, callers retry with the same key. Existing-session sends acknowledge
durable inbox acceptance, not turn completion or a synchronous dedupe verdict.

The session admission queue reconstructs its bounded key set during replay and
carries it in the handoff checkpoint. Checkpoint version 16 prevents an older
owner from silently dropping it; older checkpoints upgrade with an empty set.
All replicas must share the same durable Workflow World. Independent stores do
not share delivery identity.

This change does not add a general FIFO broker, a payload-equality check, or
provider-side acknowledgement guarantees. Other built-in channels can adopt
their own stable event IDs separately. The canonical HTTP create route keeps
its existing `operationId` contract.
