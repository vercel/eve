---
"eve": patch
---

Give each delegated local or remote agent session its own replay-stable OpenTelemetry trace. Receivers accept parent lineage only from configured trusted forwarders; an explicit untrusted-lineage rejection makes the sender retry as a capped root session without linked trace metadata.
