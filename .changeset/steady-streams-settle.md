---
"eve": minor
---

Upgrade durable streams to version 20, with required `blockIndex` coordinates for text and reasoning events and canonical durable HITL settlement results. Delegated input and authorization lifecycles now project through parent stream coordinates, accepted response retries remain no-ops after proxy routing clears or the process restarts, and parent execution resumes in a fresh canonical turn after proxied input settles. `eve/testing` exposes builders for contract-valid integration fixtures, and the eve channel supports application-owned continuation tokens, token-to-session resolution, and finite recovery replay through the captured current tail.
