---
"eve": patch
---

Session token limits, the quota a delegated agent inherits, the usage a subagent reports to its parent, and the `$eve.*` token tags now read what the session's `usage.recorded` facts record, instead of a private tally kept beside them. What a workflow call's agent spent now counts even when it arrives after the turn stopped waiting on that call: it's recorded as `delegated-late` usage.
