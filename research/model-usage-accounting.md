---
issue: https://github.com/vercel/eve/issues/5918
status: implemented
last_updated: "2026-11-12"
---

# Model usage accounting

## Summary

`usage.recorded` is the session's record of what model calls spent. Two gaps made it disagree with
what providers bill ([#5918](https://github.com/vercel/eve/issues/5918),
[#5919](https://github.com/vercel/eve/issues/5919)):

- An answer eve discards, an empty one it asks for again or one that fails the run such as a
  `content-filter` finish, recorded no usage. Only a steered answer did.
- A count the provider didn't report was recorded as 0, so an unreported cache read read as a
  cache miss, and an answer with no reported usage read as free.

## Semantics

Every answer a run receives records its usage, owned by the run, whether eve keeps it or not:

| Answer                              | Where its usage is recorded                    |
| ----------------------------------- | ---------------------------------------------- |
| Kept                                | After the completed `model.settled`, as before |
| Discarded, the run tries again      | With the `model.retried` that ends the attempt |
| Discarded after it published output | After the abandoned `model.settled`            |
| Discarded, the run fails            | After the failed `model.settled`               |
| Cut off by steering                 | After the completed `model.settled`, as before |

Discarded usage counts toward session and turn totals and `limits.sessionUsage`, as a steered
answer's always has: it is what the provider billed. A run with retries can therefore own more
than one `usage.recorded`; its row's `usage` is their sum.

`Usage` gains one optional field:

```ts
interface Usage {
  readonly cacheReadTokens: number; // 0 when unreported
  readonly cacheReadUnreported?: true;
  // …
}
```

`cacheReadUnreported: true` marks a record whose provider didn't report cache reads.
`cacheReadTokens` stays a required number, so readers and sums count what they counted before;
a reader computing cache hit rate or price skips or flags marked records. Only the cache read is
marked, since it is the count readers misread as a measurement. Totals are sums and never carry
the mark. An answer whose provider reported no count and no cost records no `usage.recorded`.

Sessions recorded before v27 convert with the same rule: v26 wrote only the counts a provider
reported, so a converted step without `cacheReadTokens` is marked, and one without any count
records no usage.

## Alternatives

- A separate `discardedUsage` field on `model.retried` and `model.settled`, left out of totals.
  Rejected: totals and limits would undercount billed spend, and steered answers already count.
- Optional counts on `Usage`. Rejected: every reader and sum would need to handle a missing count,
  a breaking change for consumers of the stream.
