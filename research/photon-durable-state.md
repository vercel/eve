---
issue: https://linear.app/marlo-today/issue/EPD-4656
status: proposed
last_updated: "2026-08-23"
---

# Durable Photon channel state

## Summary

`photonIMessageChannel` currently creates an in-memory Chat SDK state adapter
internally. Chat SDK uses that adapter for subscriptions, locks, queues, and an
atomic inbound-message deduplication entry written before message handlers run.
The hardcoded adapter makes Photon deduplication process-local even when an eve
deployment already has durable state available.

Allow callers to inject a Chat SDK `StateAdapter` and configure `dedupeTtlMs`.
Keep in-memory state as the default so existing local channels behave unchanged.

## Authoring contract

```ts
interface PhotonIMessageChannelConfig {
  readonly state?: StateAdapter;
  readonly dedupeTtlMs?: number;
}
```

The channel forwards both values to `chatSdkChannel`. When `state` is absent,
the channel calls `createMemoryState()` as it does today. When `dedupeTtlMs` is
absent, Chat SDK retains its default.

```ts
photonIMessageChannel({
  credentials,
  state: createRedisState(),
  dedupeTtlMs: 48 * 60 * 60 * 1_000,
});
```

## Semantics

Photon documents `message.id` as stable across retries. Chat SDK stores
`dedupe:imessage:<message.id>` with `StateAdapter.setIfNotExists` before invoking
the Photon message handler. A shared atomic adapter therefore admits one handler
across concurrent deliveries and recreated eve instances.

The channel does not add another deduplication layer or change the key. Projects
with multiple downstream consumers remain responsible for separate state
namespaces or consumer-specific delivery topology.

## Boundaries

- No Chat SDK or Photon adapter behavior changes.
- No new eve runtime dependency. Authors choose and install a state adapter.
- The default remains in-memory for backwards compatibility.
- State lifecycle and atomicity remain the adapter's responsibility.

## Verification

- Unit tests confirm the memory default and exact forwarding of injected state
  and `dedupeTtlMs`.
- An integration test shares one atomic state adapter across concurrent Photon
  requests and recreated channels, then confirms one `onMessage` invocation for
  a repeated `message.id`.
- A development Redis validation repeats the same concurrency and recreation
  case against `@chat-adapter/state-redis`.
