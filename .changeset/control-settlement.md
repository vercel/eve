---
"eve": patch
---

Session controls and deliveries always settle once, in order:

- A cancel that arrives during a compaction or clear settles `ignored`, and the change finishes.
- Controls sent to a prewarmed session before its first message settle `ignored` after `session.started`, instead of failing the session or never settling.
- When a hook cancels the turn a routed answer resumes, the rest of that delivery meant for the session itself settles `ignored`.
- An answer from someone who can't answer an approval is refused without settling the requester's earlier answer a second time.
