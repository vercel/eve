---
issue: https://github.com/vercel/eve/issues/1842
status: implemented
last_updated: "2026-10-20"
---

# Channel delivery idempotency

Channel and fixed-session `send()` and `respond()` calls accept an optional
`idempotencyKey`. The Chat SDK bridge forwards it, and Photon supplies its
message ID.

```ts
await from(conversationId).send(message, { auth, idempotencyKey: providerEventId });
```

The channel verifies the event and selects its ID. The session owner ignores
duplicates before routing, coalescing, or executing input. Known duplicates
cannot interrupt generation. Unkeyed sends behave as before.

Keys contain 1–256 characters. Each session remembers its last 1,024 distinct
keys in admission order; retries do not extend retention. Aliases share this
window. Reset, expiration, or replacement starts a new one. Reusing a retained
key ignores the new input, even if its contents changed. Replicas must share
the same durable Workflow World.

Initial input records its key in the workflow arguments. A losing creation
candidate forwards its command to the winning session. Keyed creation waits up
to 30 seconds for that session's ID. Existing-session sends return after durable
acceptance, without waiting for a turn or reporting whether input was a duplicate.
Callers retry ambiguous failures with the same key.

The admission queue rebuilds its key set on replay and saves it in the handoff
checkpoint. Checkpoint version 16 prevents older owners from dropping the set;
older checkpoints upgrade with an empty set.

This does not guarantee exactly-once external effects, webhook acknowledgements,
or ordering between distinct deliveries. Other built-in channels can adopt
provider IDs separately. HTTP session creation keeps its `operationId` contract.
