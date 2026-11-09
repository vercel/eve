---
"eve": minor
---

`eve/events` exports `createStreamChecker`, which checks a stored session stream against its lifecycle rules.

Run it over a stored or recorded stream to find lines that break the lifecycle rules, such as a turn that settles twice or a fact that names something never introduced. Its `StreamChecker`, `Violation`, and `ViolationRule` types, and the `StoredLine`, `CommitLine`, and `ProgressLine` types it reads, are exported beside it.
