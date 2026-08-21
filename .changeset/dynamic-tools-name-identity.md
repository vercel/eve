---
"eve": patch
---

Dynamic tool callbacks are now identified by tool name and phase instead of byte offsets in the authored source. Editing an agent file no longer risks a parked approval replaying the wrong tool: after a redeploy or crash, parked calls run the latest deployed callback code under the same name, and a tool that no longer exists fails closed with an explicit error. Session-scoped resolvers may run once more on resume to rebind callbacks, so keep them idempotent.
