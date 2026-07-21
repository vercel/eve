---
"eve": minor
---

Upgrade durable streams to version 20, with required `blockIndex` coordinates for text and reasoning events and canonical durable HITL settlement results. Delegated input and authorization lifecycles now project through parent stream coordinates, and parent execution resumes them in a fresh canonical turn after proxied input settles. `eve/testing` exposes builders for contract-valid integration fixtures, and the eve channel supports application-owned continuation tokens, token-to-session resolution, and finite recovery replay through the captured current tail.
