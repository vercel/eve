---
issue: https://github.com/vercel/eve/issues/4506
status: implemented
last_updated: "2026-11-24"
---

# Keep keyed memory updates append-only

A changed keyed recall normally removes the old record from its original turn.
This breaks provider prompt-cache reuse from that turn onward, even if the
rest of the conversation has not changed.

## Authoring API

Set `supersede: "append"` on the slot's `defineMemory()` call. Omit it or set
`"hide"` to continue removing older versions immediately.

- A changed record with the same `id` appears before the new turn's input
  without editing older turns. eve identifies each keyed record and tells the
  model to use its latest version. Identical content adds nothing.
- Successful compaction keeps only the latest version for each `id`. Failed
  compaction keeps all versions. Recalled memory stays out of the summary.
- Unkeyed records, session clear, and scope changes retain their existing
  behavior. Append mode is not a way to revoke old content before compaction.

Previous versions count toward the model's context until compaction succeeds.
The option preserves the prompt prefix when memory changes, but the provider
still determines whether to reuse its cache.
