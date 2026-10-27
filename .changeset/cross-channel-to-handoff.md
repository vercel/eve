---
"eve": patch
---

Messages a route forwards with `ctx.to()` now carry the deployment and request that accepted them, so an idle session reached that way hands off to the new deployment like one reached with `from()`. Thanks @haydenbleasel for reporting this in #5408.
