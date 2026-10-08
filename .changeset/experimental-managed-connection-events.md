---
"eve": patch
---

Add experimental Connect-managed event subscription actions, per-connection webhook receivers, and durable event/lifecycle callbacks for existing sessions. Subscription results expose eve's local retirement alongside Connect's status. Requires the managed-events AI SDK and Connect releases.

Keep the session deadline stable across workflow replay and compaction handoffs.

Return immediately from the durable sleep tool when steering has already interrupted its execution.
