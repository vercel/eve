---
"eve": patch
---

Delegated subagent sessions now receive a share of the parent's remaining token quota at dispatch time — the remainder split across the batch's delegated calls — instead of a fixed 5M input-token cap, and a completed child's usage counts against the parent's quota, so a delegation tree can never outspend the budget configured at its root. Session token limits also accept `false` to uncap a session explicitly.
