---
"eve": patch
---

Keep the cancelled-turn epilogue inside the eve context. Cancelling a turn whose message carried an attachment failed `turnStep` with "No active eve context" — the harness step's ALS scope had already closed, so staging the preserved message's file parts threw, and the retries made it a terminal session failure.
