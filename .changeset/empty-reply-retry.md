---
"eve": minor
---

Add `emptyReply: "retry"` to `defineAgent` so a root session retries an empty model reply once, instead of completing the turn without a reply.

Providers sometimes end a turn with `finishReason: "stop"` and nothing in it. By default (`"accept"`), root sessions still accept that, so an agent can stay quiet. With `"retry"`, eve reissues the call once, as it already does for delegated sessions, and fails the turn if the reply stays empty. An agent with this option on stays quiet by calling `no_reply`.

Thanks @zackleman for proposing this in #5914.
