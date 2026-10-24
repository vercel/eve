---
"eve": minor
---

`SessionStore` replaces `EveAgentStore`, and clients and frontend bindings use `baseUrl` instead of `host`. Frontend bindings expose `view`, `messages`, and `agents` directly with native tool and interaction parts; use `followWhile(view)` instead of `followIdle`, and `activeTurn(view)` rather than busy status for Stop controls.
