---
"eve": patch
---

Give each delegated local or remote agent session its own replay-stable OpenTelemetry trace. Receivers accept parent lineage only from configured trusted forwarders; otherwise compatible senders retry as capped root sessions without linked trace metadata.
