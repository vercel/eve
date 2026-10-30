---
issue: "None (maintainer-approved pre-1.0 client API proposal)"
status: implemented
last_updated: "2026-10-21"
---

# Client receipt following

## Authoring API

```ts
const receipt = await chat.send("Summarize the report.");
sidebar.follow(receipt);

useEveAgent({ followWhile: (view) => !idle(view) });
```

`follow(receipt): void` registers a synchronous, idempotent obligation against the store's existing session. A missing or different session throws; the receipt grants no access. The store stays busy until its committed view shows the delivery settled or the session ends. A repeated call can reopen the stream after a transport error. No per-receipt promise is exposed. No receipt, including one submitted locally, turns historical catch-up into live completion callbacks; recorded failures can still update the snapshot.

`followWhile(view)` replaces the previous idle-only boolean option. It defaults to true and decides whether to keep the stream open after a committed line. Local POSTs, unsettled receipts, and resume catch-up override the predicate. The predicate can close during active work; the busy snapshot then remains frozen until any command, resume, or follow reopens from the store's own committed cursor. Bindings use the latest callback without recreating their store.

## Boundary

No server changes or receipt reconstruction API. The store folds complete lines and keeps the full client projection; it does not trim settled deliveries. Ordinary session stream authentication applies on every reopen. Delivery settlement, rather than turn completion, releases a receipt's obligation, including when the turn pauses for input.
