---
issue: https://github.com/vercel/eve/issues/5918
status: implemented
last_updated: "2026-11-12"
---

# Model usage accounting

## Summary

`usage.recorded` is the session's record of what model calls spent. An answer eve discards, an
empty one it asks for again or one that fails the run such as a `content-filter` finish, recorded
no usage, so session totals disagreed with what providers bill
([#5918](https://github.com/vercel/eve/issues/5918)). Only a steered answer did.

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

## Alternatives

- A separate `discardedUsage` field on `model.retried` and `model.settled`, left out of totals.
  Rejected: totals and limits would undercount billed spend, and steered answers already count.
