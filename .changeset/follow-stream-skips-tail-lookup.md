---
"eve": patch
---

A session stream request that does not report the durable tail no longer looks it up. Default opens and client reconnects now check that the session exists with one run lookup, instead of a tail lookup that on the local world opens every chunk file. Unknown and expired sessions still answer 404 and 410 before the stream starts. Thanks @KingAmo for reporting this in #5016.
